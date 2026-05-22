import "server-only";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { runSupabaseDataPlaneProbe } from "@/repositories/mcp-connectors/supabase-mcp-connector";
import { fail, pass, warn, type CheckResult } from "@/core/verification";

/**
 * Phase E2.7 — supabase_mcp_probe_check.
 *
 * Bridges the runtime probe into the verification pipeline. Today the
 * probe runs in `internal_db_probe` mode; the check returns a warning
 * (not a fail) when no direct MCP bridge exists — the project does not
 * require direct MCP to merge a PR.
 *
 * Rules:
 *   - probe failures (no required tables, RLS leak, exceptions) → fail.
 *   - probe degraded (some capabilities missing, e.g. list_migrations) → warning.
 *   - probe healthy + internal mode → warning ("DB probe healthy; direct MCP not yet probeable.")
 *   - probe healthy + direct_mcp mode → pass.
 */
export async function runSupabaseMcpProbeCheck(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const membership = await getPrimaryWorkspace();
    if (!membership) {
      return warn({
        check: "supabase_mcp_probe_check",
        label: "Supabase MCP probe",
        summary: "No workspace available.",
        details: ["Sign in and create a workspace before running this check."],
        durationMs: Date.now() - start,
        requiresUserAction: true,
        blocksMerge: false,
      });
    }
    const result = await runSupabaseDataPlaneProbe({
      workspaceId: membership.workspaceId,
    });

    const detailLines: string[] = [
      `mode=${result.mode}`,
      `status=${result.status}`,
      ...Object.entries(result.capabilities).map(([k, v]) => `${k}=${v}`),
      `tables=${result.evidence.table_count}/${result.evidence.required_table_count}`,
    ];
    if (result.evidence.required_tables_missing.length > 0) {
      detailLines.push(
        `missing=${result.evidence.required_tables_missing.join(",")}`,
      );
    }
    detailLines.push(...result.evidence.warnings.slice(0, 5));

    if (result.status === "failed") {
      return fail({
        check: "supabase_mcp_probe_check",
        label: "Supabase MCP probe",
        summary: "Supabase probe failed — required tables missing or RLS leak.",
        details: detailLines,
        durationMs: Date.now() - start,
        blocksMerge: true,
      });
    }

    if (result.mode === "internal_db_probe") {
      // Honest: we ran the DB probe, not a direct MCP probe. Always
      // a warning regardless of healthy/degraded — never claims direct
      // MCP is connected.
      if (result.status === "degraded") {
        return warn({
          check: "supabase_mcp_probe_check",
          label: "Supabase MCP probe",
          summary:
            "DB probe degraded; direct MCP connector not yet probeable.",
          details: detailLines,
          durationMs: Date.now() - start,
          requiresUserAction: false,
          blocksMerge: false,
        });
      }
      return warn({
        check: "supabase_mcp_probe_check",
        label: "Supabase MCP probe",
        summary:
          "Internal Supabase DB probe passed; direct MCP connector not yet probeable.",
        details: detailLines,
        durationMs: Date.now() - start,
        requiresUserAction: false,
        blocksMerge: false,
      });
    }

    // operator_bridge or direct_mcp — pass when healthy.
    if (result.status === "healthy") {
      return pass({
        check: "supabase_mcp_probe_check",
        label: "Supabase MCP probe",
        summary: "Supabase MCP probe healthy.",
        details: detailLines,
        durationMs: Date.now() - start,
      });
    }
    return warn({
      check: "supabase_mcp_probe_check",
      label: "Supabase MCP probe",
      summary: "Supabase MCP probe degraded.",
      details: detailLines,
      durationMs: Date.now() - start,
      requiresUserAction: true,
      blocksMerge: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Probe threw.";
    return fail({
      check: "supabase_mcp_probe_check",
      label: "Supabase MCP probe",
      summary: message,
      details: [],
      durationMs: Date.now() - start,
      blocksMerge: false,
    });
  }
}
