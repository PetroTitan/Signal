import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createSupabaseServerClient } from "@/lib/supabase";
import { readSupabaseEnv } from "@/lib/supabase/env";
import {
  isOAuthProviderConfigured,
  hasTokenEncryptionKey,
} from "@/lib/oauth/env";
import { OAUTH_PLATFORMS } from "@/core/platform-oauth";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  fail,
  pass,
  warn,
  type CheckResult,
} from "@/core/verification";

const REPO_ROOT = process.cwd();

/**
 * Workspace-scoped tables that must have RLS enabled with a workspace
 * member policy. Keeping this list explicit is intentional — adding a
 * table here forces a deliberate decision about its access model.
 */
const WORKSPACE_SCOPED_TABLES = [
  "workspaces",
  "workspace_members",
  "workspace_settings",
  "products",
  "growth_accounts",
  "weekly_plans",
  "weekly_plan_items",
  "approval_events",
  "backlog_items",
  "scheduled_items",
  "risk_events",
  "draft_variants",
  "activity_events",
  "mcp_operation_runs",
  "weekly_approval_contracts",
  "weekly_contract_accounts",
  "weekly_contract_products",
  "weekly_contract_platforms",
  "weekly_contract_allowed_actions",
  "weekly_contract_execution_windows",
  "execution_authorizations",
  "execution_queues",
  "execution_items",
  "execution_logs",
  "execution_attempts",
  "platform_connections",
  "oauth_state_tokens",
] as const;

// =====================================================================
// env_check
// =====================================================================

export async function runEnvCheck(): Promise<CheckResult> {
  const start = Date.now();
  const details: string[] = [];
  const env = readSupabaseEnv();
  if (!env) {
    return fail({
      check: "env_check",
      label: "Environment check",
      summary: "Supabase env is missing or invalid.",
      details: [
        "NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is unset, empty, or malformed.",
      ],
      durationMs: Date.now() - start,
    });
  }
  details.push(`Supabase URL host: ${new URL(env.url).host}`);
  details.push("Anon key present.");

  const demoModeRaw = process.env.NEXT_PUBLIC_SIGNAL_DEMO_MODE ?? "";
  details.push(`Demo mode env: "${demoModeRaw || "(unset)"}"`);

  const oauthSummary = OAUTH_PLATFORMS.map(
    (p) => `${p}: ${isOAuthProviderConfigured(p) ? "configured" : "not configured"}`,
  );
  details.push(`OAuth providers — ${oauthSummary.join(", ")}.`);
  details.push(
    `Token encryption: ${hasTokenEncryptionKey() ? "configured" : "not configured"}.`,
  );

  return pass({
    check: "env_check",
    label: "Environment check",
    summary: "Supabase env resolves and the URL is valid.",
    details,
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// auth_check
// =====================================================================

export async function runAuthCheck(): Promise<CheckResult> {
  const start = Date.now();
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return fail({
      check: "auth_check",
      label: "Auth check",
      summary: "No authenticated user in this request.",
      details: [
        "Sign in before running the verification pipeline; the runner uses the operator's session.",
      ],
      durationMs: Date.now() - start,
    });
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return fail({
      check: "auth_check",
      label: "Auth check",
      summary: "User has no workspace membership.",
      details: [
        `User: ${user.email ?? user.id}`,
        "Create a workspace from the dashboard before running the pipeline.",
      ],
      durationMs: Date.now() - start,
    });
  }
  return pass({
    check: "auth_check",
    label: "Auth check",
    summary: "User authenticated and has a workspace membership.",
    details: [
      `User: ${user.email ?? user.id}`,
      `Workspace: ${membership.workspace.name} (${membership.workspaceId})`,
      `Role: ${membership.role}`,
    ],
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// rls_check
// =====================================================================

export async function runRlsCheck(): Promise<CheckResult> {
  const start = Date.now();
  const supabase = createSupabaseServerClient();

  // Probe each workspace-scoped table. RLS is correctly applied when
  // every returned row belongs to a workspace the current user is a
  // member of. For tables without a workspace_id column we just
  // require the select to succeed (RLS may scope by user_id instead).
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return warn({
      check: "rls_check",
      label: "RLS check",
      summary: "Cannot evaluate RLS without a workspace membership.",
      details: ["Sign in and create a workspace before running this check."],
      durationMs: Date.now() - start,
      requiresUserAction: true,
    });
  }
  const workspaceId = membership.workspaceId;
  const issues: string[] = [];
  const okTables: string[] = [];

  for (const table of WORKSPACE_SCOPED_TABLES) {
    try {
      const { data, error } = await supabase
        .from(table)
        // For tables without workspace_id (e.g. workspace_members)
        // we still get a row shape; we read the column when present.
        .select("workspace_id")
        .limit(20);
      if (error) {
        issues.push(`${table}: select failed (${error.message})`);
        continue;
      }
      const rows = (data ?? []) as Array<{ workspace_id?: string | null }>;
      const leak = rows.find(
        (r) =>
          r.workspace_id !== undefined &&
          r.workspace_id !== null &&
          r.workspace_id !== workspaceId,
      );
      if (leak) {
        issues.push(
          `${table}: row visible from a different workspace (${leak.workspace_id}).`,
        );
        continue;
      }
      okTables.push(table);
    } catch (err) {
      issues.push(
        `${table}: probe threw ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }

  if (issues.length > 0) {
    return fail({
      check: "rls_check",
      label: "RLS check",
      summary: `${issues.length} RLS issue(s) detected.`,
      details: issues,
      durationMs: Date.now() - start,
    });
  }
  return pass({
    check: "rls_check",
    label: "RLS check",
    summary: `All ${okTables.length} workspace-scoped tables enforce RLS for this session.`,
    details: [`Probed: ${okTables.join(", ")}`],
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// db_integrity_check
// =====================================================================

export async function runDbIntegrityCheck(): Promise<CheckResult> {
  const start = Date.now();
  const supabase = createSupabaseServerClient();
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return warn({
      check: "db_integrity_check",
      label: "Database integrity check",
      summary: "No workspace to probe.",
      details: [],
      durationMs: Date.now() - start,
      requiresUserAction: true,
    });
  }
  const workspaceId = membership.workspaceId;
  const findings: string[] = [];

  async function countRows(table: string): Promise<number | null> {
    const { count, error } = await supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (error) {
      findings.push(`${table}: count failed (${error.message})`);
      return null;
    }
    return count ?? 0;
  }

  const tables = [
    "products",
    "growth_accounts",
    "weekly_plans",
    "weekly_plan_items",
    "weekly_approval_contracts",
    "execution_queues",
    "execution_items",
    "execution_logs",
    "execution_attempts",
    "platform_connections",
    "activity_events",
    "mcp_operation_runs",
  ];
  const counts: Record<string, number | null> = {};
  for (const t of tables) {
    counts[t] = await countRows(t);
  }

  // Orphan probe: execution_items must reference an existing queue and
  // contract in the same workspace.
  try {
    const { data: items, error } = await supabase
      .from("execution_items")
      .select("id, queue_id, contract_id")
      .eq("workspace_id", workspaceId);
    if (error) {
      findings.push(`execution_items: select failed (${error.message})`);
    } else if (items && items.length > 0) {
      const queueIds = Array.from(
        new Set(
          (items as Array<{ queue_id: string | null }>)
            .map((r) => r.queue_id)
            .filter((id): id is string => typeof id === "string"),
        ),
      );
      const contractIds = Array.from(
        new Set(
          (items as Array<{ contract_id: string | null }>)
            .map((r) => r.contract_id)
            .filter((id): id is string => typeof id === "string"),
        ),
      );
      if (queueIds.length > 0) {
        const { data: queues } = await supabase
          .from("execution_queues")
          .select("id")
          .eq("workspace_id", workspaceId)
          .in("id", queueIds);
        const foundQueues = new Set(
          ((queues ?? []) as Array<{ id: string }>).map((q) => q.id),
        );
        const missingQueues = queueIds.filter((id) => !foundQueues.has(id));
        if (missingQueues.length > 0) {
          findings.push(
            `${missingQueues.length} execution_items reference missing queues.`,
          );
        }
      }
      if (contractIds.length > 0) {
        const { data: contracts } = await supabase
          .from("weekly_approval_contracts")
          .select("id")
          .eq("workspace_id", workspaceId)
          .in("id", contractIds);
        const foundContracts = new Set(
          ((contracts ?? []) as Array<{ id: string }>).map((c) => c.id),
        );
        const missingContracts = contractIds.filter(
          (id) => !foundContracts.has(id),
        );
        if (missingContracts.length > 0) {
          findings.push(
            `${missingContracts.length} execution_items reference missing contracts.`,
          );
        }
      }
    }
  } catch (err) {
    findings.push(
      `execution_items orphan probe threw ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  const summary = Object.entries(counts)
    .map(([t, c]) => `${t}=${c ?? "?"}`)
    .join(", ");

  if (findings.length > 0) {
    return fail({
      check: "db_integrity_check",
      label: "Database integrity check",
      summary: `${findings.length} integrity finding(s).`,
      details: [...findings, `Counts: ${summary}`],
      durationMs: Date.now() - start,
    });
  }
  return pass({
    check: "db_integrity_check",
    label: "Database integrity check",
    summary: "No orphaned execution items or count errors.",
    details: [`Counts: ${summary}`],
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// route_protection_check
// =====================================================================
//
// A static check over the middleware + (app)/layout sources. Confirms
// the protected-route guard is present and fail-closed.

export async function runRouteProtectionCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: string[] = [];

  const middlewareFiles = [
    path.join(REPO_ROOT, "src/lib/supabase/middleware.ts"),
    path.join(REPO_ROOT, "middleware.ts"),
    path.join(REPO_ROOT, "src/middleware.ts"),
  ];
  let mwSource = "";
  for (const f of middlewareFiles) {
    try {
      mwSource += await fs.readFile(f, "utf8");
      mwSource += "\n";
    } catch {
      // file may not exist; that's fine for non-canonical paths
    }
  }
  if (!mwSource) {
    findings.push("Could not read middleware sources.");
  } else {
    if (!/redirect\.pathname\s*=\s*["']\/login["']/.test(mwSource)) {
      findings.push("Middleware does not redirect unauthenticated requests to /login.");
    }
    if (!/auth_unavailable/.test(mwSource)) {
      findings.push(
        "Middleware does not appear to fail closed when Supabase env is missing (reason=auth_unavailable not found).",
      );
    }
  }

  // (app)/layout.tsx — fail-closed when membership is missing.
  try {
    const layout = await fs.readFile(
      path.join(REPO_ROOT, "src/app/(app)/layout.tsx"),
      "utf8",
    );
    if (!/getPrimaryWorkspace|getUser|auth\.getUser/.test(layout)) {
      findings.push(
        "(app)/layout.tsx does not appear to enforce auth/workspace before rendering.",
      );
    }
  } catch {
    findings.push("Could not read src/app/(app)/layout.tsx.");
  }

  if (findings.length > 0) {
    return fail({
      check: "route_protection_check",
      label: "Route protection check",
      summary: "Route protection looks incomplete.",
      details: findings,
      durationMs: Date.now() - start,
    });
  }
  return pass({
    check: "route_protection_check",
    label: "Route protection check",
    summary: "Middleware fails closed on missing env and redirects unauthenticated requests.",
    details: [
      "src/lib/supabase/middleware.ts: /login redirect path present.",
      "src/lib/supabase/middleware.ts: auth_unavailable reason set when env is missing.",
      "src/app/(app)/layout.tsx: auth/membership guard present.",
    ],
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// demo_boundary_check
// =====================================================================

export async function runDemoBoundaryCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: string[] = [];
  const demoModeRaw =
    (process.env.NEXT_PUBLIC_SIGNAL_DEMO_MODE ?? "").trim().toLowerCase();
  const demoOn = demoModeRaw === "true" || demoModeRaw === "1";

  // Even when demo is off in env, the engine safety envelope must
  // refuse demo workspaces. We check the source for that guard.
  try {
    const safety = await fs.readFile(
      path.join(REPO_ROOT, "src/core/execution-engine/execution-safety.ts"),
      "utf8",
    );
    if (!/isDemoWorkspace/.test(safety) || !/never authorize execution/i.test(safety)) {
      findings.push(
        "execution-safety.ts is missing the demo-workspace guard.",
      );
    }
  } catch {
    findings.push("Could not read src/core/execution-engine/execution-safety.ts.");
  }

  try {
    const evaluator = await fs.readFile(
      path.join(REPO_ROOT, "src/core/weekly-contract/contract-evaluator.ts"),
      "utf8",
    );
    if (!/demo_mode_blocked/.test(evaluator)) {
      findings.push(
        "contract-evaluator.ts does not return demo_mode_blocked for demo workspaces.",
      );
    }
  } catch {
    findings.push("Could not read contract-evaluator.ts.");
  }

  if (findings.length > 0) {
    return fail({
      check: "demo_boundary_check",
      label: "Demo boundary check",
      summary: "Demo-mode boundary code is missing or incomplete.",
      details: findings,
      durationMs: Date.now() - start,
    });
  }

  if (demoOn) {
    return warn({
      check: "demo_boundary_check",
      label: "Demo boundary check",
      summary: "Demo mode is currently ON.",
      details: [
        "NEXT_PUBLIC_SIGNAL_DEMO_MODE is true.",
        "Engine safety guard is present and will refuse execution.",
      ],
      durationMs: Date.now() - start,
      requiresUserAction: false,
      blocksMerge: false,
    });
  }
  return pass({
    check: "demo_boundary_check",
    label: "Demo boundary check",
    summary: "Demo mode is off and the engine guard is in place.",
    details: ["Engine safety envelope refuses demo workspaces."],
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// production_smoke_test
// =====================================================================
//
// Reuses the existing read-only smoke test from Phase E0.

export async function runProductionSmokeTest(): Promise<CheckResult> {
  const start = Date.now();
  const { runWorkspaceSmokeTest } = await import(
    "@/repositories/admin-operations/smoke-test-operations"
  );
  const result = await runWorkspaceSmokeTest();
  if (!result.ok) {
    return fail({
      check: "production_smoke_test",
      label: "Workspace smoke test",
      summary: result.error,
      details: result.notes,
      durationMs: Date.now() - start,
      blocksMerge: false,
    });
  }
  const okCount = result.payload.checks.filter((c) => c.ok).length;
  return pass({
    check: "production_smoke_test",
    label: "Workspace smoke test",
    summary: `${okCount}/${result.payload.checks.length} probes passed.`,
    details: result.payload.checks.map(
      (c) => `${c.name}: ${c.ok ? "ok" : "failed"}${c.detail ? ` — ${c.detail}` : ""}`,
    ),
    durationMs: Date.now() - start,
    blocksMerge: false,
  });
}
