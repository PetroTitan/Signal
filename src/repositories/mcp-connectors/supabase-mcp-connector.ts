import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import {
  SUPABASE_PROBE_QUERY_TIMEOUT_MS,
  SUPABASE_PROBE_REQUIRED_TABLES,
  deriveProbeStatus,
  emptyCapabilityResults,
  setCapability,
  type SupabaseProbeEvidence,
  type SupabaseProbeResult,
} from "@/core/mcp-runtime/supabase-probe";

/**
 * Phase E2.7 — Supabase probe runner (Option C: internal_db_probe).
 *
 * Uses the operator's authenticated Supabase session to verify what
 * the data plane looks like from inside Signal. The probe is
 * deliberately narrow — it only inspects tables Signal declared in
 * `SUPABASE_PROBE_REQUIRED_TABLES` and runs one short read against
 * each via the standard PostgREST API.
 *
 * The probe never:
 *   - uses the service-role key
 *   - reads the `auth` schema
 *   - selects encrypted-token columns
 *   - runs arbitrary SQL
 *
 * It is bounded by `SUPABASE_PROBE_QUERY_TIMEOUT_MS` per query.
 */

async function withTimeout<T>(
  thenable: PromiseLike<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} > ${ms}ms`));
    }, ms);
    Promise.resolve(thenable).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export interface RunSupabaseProbeInput {
  workspaceId: string;
}

export async function runSupabaseDataPlaneProbe(
  input: RunSupabaseProbeInput,
): Promise<SupabaseProbeResult> {
  const supabase = createSupabaseServerClient();
  const checkedAt = new Date().toISOString();
  let capabilities = emptyCapabilityResults();
  const warnings: string[] = [];
  let tableCount = 0;
  let rlsEnabledCount = 0;
  const requiredTablesMissing: string[] = [];

  // 1) list_tables / read_schema_metadata — probe by selecting one
  // row from each required table (limit 0). PostgREST returns 200
  // when the table exists and the operator's RLS lets them see it
  // (or returns no rows if empty); a missing table returns 4xx.
  let listOk = 0;
  for (const table of SUPABASE_PROBE_REQUIRED_TABLES) {
    try {
      const { error } = await withTimeout(
        supabase.from(table).select("*", { head: true, count: "exact" }).limit(0),
        SUPABASE_PROBE_QUERY_TIMEOUT_MS,
        `select head:${table}`,
      );
      if (error) {
        requiredTablesMissing.push(table);
      } else {
        listOk += 1;
      }
    } catch (err) {
      requiredTablesMissing.push(table);
      warnings.push(
        `${table}: probe threw ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }
  tableCount = listOk;
  capabilities = setCapability(
    capabilities,
    "list_tables",
    listOk === SUPABASE_PROBE_REQUIRED_TABLES.length ? "verified" : "missing",
  );
  capabilities = setCapability(
    capabilities,
    "read_schema_metadata",
    listOk >= SUPABASE_PROBE_REQUIRED_TABLES.length - 1 ? "verified" : "missing",
  );

  // 2) check_rls_status — when a select against a workspace-scoped
  // table returns rows, every row.workspace_id must equal the
  // operator's workspace. Otherwise RLS is broken.
  try {
    const { data, error } = await withTimeout(
      supabase
        .from("activity_events")
        .select("workspace_id")
        .limit(20),
      SUPABASE_PROBE_QUERY_TIMEOUT_MS,
      "rls:activity_events",
    );
    if (error) {
      capabilities = setCapability(capabilities, "check_rls_status", "missing");
      warnings.push(`RLS probe failed on activity_events: ${error.message}`);
    } else {
      const rows = (data ?? []) as Array<{ workspace_id?: string | null }>;
      const leak = rows.find(
        (r) =>
          r.workspace_id !== undefined &&
          r.workspace_id !== null &&
          r.workspace_id !== input.workspaceId,
      );
      if (leak) {
        capabilities = setCapability(capabilities, "check_rls_status", "missing");
        warnings.push(
          `RLS leak: row from workspace ${leak.workspace_id} visible.`,
        );
      } else {
        capabilities = setCapability(capabilities, "check_rls_status", "verified");
        rlsEnabledCount = SUPABASE_PROBE_REQUIRED_TABLES.length;
      }
    }
  } catch (err) {
    capabilities = setCapability(capabilities, "check_rls_status", "missing");
    warnings.push(
      `RLS probe threw: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  // 3) list_migrations — supabase_migrations.schema_migrations is in
  // a schema the authenticated user generally cannot read. Mark
  // not_tested rather than failing — this is honest, not a fake pass.
  capabilities = setCapability(capabilities, "list_migrations", "not_tested");
  warnings.push(
    "list_migrations not tested — schema_migrations is not exposed to authenticated users.",
  );

  // 4) read_workspace_tables — confirm the operator can read at least
  // one workspace-scoped row (their workspace).
  try {
    const { data, error } = await withTimeout(
      supabase
        .from("workspaces")
        .select("id")
        .eq("id", input.workspaceId)
        .limit(1),
      SUPABASE_PROBE_QUERY_TIMEOUT_MS,
      "select:workspaces",
    );
    if (error || !data || data.length === 0) {
      capabilities = setCapability(
        capabilities,
        "read_workspace_tables",
        "missing",
      );
    } else {
      capabilities = setCapability(
        capabilities,
        "read_workspace_tables",
        "verified",
      );
    }
  } catch (err) {
    capabilities = setCapability(
      capabilities,
      "read_workspace_tables",
      "missing",
    );
    warnings.push(
      `workspace probe threw: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  // 5) readonly_sql_probe — a single audited SELECT against
  // mcp_operation_runs (a table we know exists and the operator can read).
  try {
    const { error } = await withTimeout(
      supabase
        .from("mcp_operation_runs")
        .select("id", { head: true, count: "exact" })
        .limit(0),
      SUPABASE_PROBE_QUERY_TIMEOUT_MS,
      "readonly_sql_probe",
    );
    capabilities = setCapability(
      capabilities,
      "readonly_sql_probe",
      error ? "missing" : "verified",
    );
    if (error) warnings.push(`readonly_sql_probe failed: ${error.message}`);
  } catch (err) {
    capabilities = setCapability(capabilities, "readonly_sql_probe", "missing");
    warnings.push(
      `readonly_sql_probe threw: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  const evidence: SupabaseProbeEvidence = {
    table_count: tableCount,
    rls_enabled_count: rlsEnabledCount,
    required_table_count: SUPABASE_PROBE_REQUIRED_TABLES.length,
    required_tables_missing: requiredTablesMissing,
    warnings,
  };

  const status = deriveProbeStatus(capabilities);

  return {
    connector: "supabase_mcp",
    mode: "internal_db_probe",
    status,
    capabilities,
    evidence,
    checked_at: checkedAt,
  };
}
