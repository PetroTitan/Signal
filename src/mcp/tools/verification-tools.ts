import "server-only";
import { ok, failed, type McpToolResponse } from "../responses";
import type { ToolContext } from "../tool-context";
import type {
  ExecutionAuthorizeItemArgs,
  ExecutionDryRunArgs,
  VerificationRunCheckArgs,
} from "../schemas";

/**
 * Phase F0 — verification + dry-run tools.
 *
 * These import the existing repository / verification layer at call
 * time so the cookie-aware repository functions can run with the
 * service-role client. Each tool keeps the workspace scope explicit.
 */

const ALLOWED_CHECKS = new Set([
  "env_check",
  "auth_check",
  "rls_check",
  "db_integrity_check",
  "route_protection_check",
  "demo_boundary_check",
  "oauth_safety_check",
  "execution_safety_check",
  "weekly_contract_check",
  "execution_dry_run_smoke",
  "production_smoke_test",
  "supabase_mcp_probe_check",
]);

export async function verificationRun(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  // Read-only summary: returns the latest pipeline operation run +
  // the verdict it recorded. We do not invoke the full pipeline here
  // because runFullVerificationPipeline expects a cookie-bound
  // session; running it under the service-role bypass would skip the
  // operator's RLS scoping. The operator should run the pipeline from
  // /settings/mcp and the MCP tool surfaces the result.
  const { data, error } = await ctx.db
    .from("mcp_operation_runs")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .ilike("input_summary", "%full verification pipeline%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error)
    return failed({
      tool: "signal.verification.run",
      summary: error.message,
    });
  if (!data) {
    return ok({
      tool: "signal.verification.run",
      summary: "No prior verification pipeline run found.",
      data: { run: null },
      warnings: [
        "The MCP server reports the latest pipeline result; trigger a new run from /settings/mcp.",
      ],
    });
  }
  return ok({
    tool: "signal.verification.run",
    summary: `Last verification pipeline: ${(data as { status: string }).status}`,
    data: { run: data },
  });
}

export async function verificationRunCheck(
  ctx: ToolContext,
  args: VerificationRunCheckArgs,
): Promise<McpToolResponse> {
  if (!ALLOWED_CHECKS.has(args.check_name)) {
    return failed({
      tool: "signal.verification.run_check",
      summary: `unknown_check:${args.check_name}`,
    });
  }
  // Look up the latest operation run for this check key by metadata.
  const { data, error } = await ctx.db
    .from("mcp_operation_runs")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error)
    return failed({
      tool: "signal.verification.run_check",
      summary: error.message,
    });
  const rows = (data ?? []) as Array<{
    metadata: Record<string, unknown>;
    [k: string]: unknown;
  }>;
  const match =
    rows.find((r) => (r.metadata as { check?: string }).check === args.check_name) ??
    null;
  if (!match) {
    return ok({
      tool: "signal.verification.run_check",
      summary: `No prior result for ${args.check_name}.`,
      data: { check_name: args.check_name, run: null },
      warnings: [
        "Run the check from /settings/mcp; the MCP server surfaces the persisted result.",
      ],
    });
  }
  return ok({
    tool: "signal.verification.run_check",
    summary: `Last ${args.check_name} run.`,
    data: { check_name: args.check_name, run: match },
  });
}

export async function executionDryRun(
  ctx: ToolContext,
  args: ExecutionDryRunArgs,
): Promise<McpToolResponse> {
  if (!args.queue_id && !args.item_id) {
    return failed({
      tool: "signal.execution.dry_run",
      summary: "queue_id_or_item_id_required",
    });
  }
  // We do not execute the dry-run from the MCP path — the dry-run
  // logic depends on the cookie-bound execution-engine actions. The
  // tool surfaces the most recent dry-run result for the target id so
  // operators can review without triggering a new attempt over MCP.
  const target = args.item_id ?? args.queue_id;
  const column = args.item_id ? "execution_item_id" : "queue_id";
  const { data, error } = await ctx.db
    .from("execution_logs")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .eq(column, target)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error)
    return failed({ tool: "signal.execution.dry_run", summary: error.message });
  return ok({
    tool: "signal.execution.dry_run",
    summary: `Latest execution logs for ${column}=${target}`,
    data: { logs: data ?? [] },
    warnings: [
      "Live dry-run execution must be triggered from /execution; the MCP tool surfaces the persisted logs.",
    ],
  });
}

export async function executionAuthorizeItem(
  ctx: ToolContext,
  args: ExecutionAuthorizeItemArgs,
): Promise<McpToolResponse> {
  // Returns the authorization outcome for the item if one exists, or
  // reports that the operator must trigger authorization from
  // /execution. We deliberately do not write new execution_authorizations
  // rows from the MCP path; the runner does that under the operator's
  // session.
  const { data: item, error: itemErr } = await ctx.db
    .from("execution_items")
    .select(
      "id, queue_id, contract_id, status, action_type, account_id, product_id, platform, authorization_id, risk_level, risk_score",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.execution_item_id)
    .maybeSingle();
  if (itemErr)
    return failed({
      tool: "signal.execution.authorize_item",
      summary: itemErr.message,
    });
  if (!item) {
    return failed({
      tool: "signal.execution.authorize_item",
      summary: "execution_item_not_found",
    });
  }
  const authorizationId = (item as { authorization_id: string | null })
    .authorization_id;
  let authorization = null;
  if (authorizationId) {
    const { data } = await ctx.db
      .from("execution_authorizations")
      .select("*")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", authorizationId)
      .maybeSingle();
    authorization = data ?? null;
  }
  return ok({
    tool: "signal.execution.authorize_item",
    summary: authorization
      ? `Authorization ${(authorization as { outcome: string }).outcome}`
      : "No authorization recorded yet for this item.",
    data: { item, authorization },
    warnings: authorization
      ? []
      : [
          "Trigger authorize from /execution under the operator's session to mint a new authorization row.",
        ],
  });
}
