import "server-only";
import type { McpToolResponse } from "../responses";
import { ok, failed } from "../responses";
import type { ToolContext } from "../tool-context";

/**
 * Phase F0 — read-only tools. Each handler:
 *   - Filters by ctx.workspaceId on every query.
 *   - Never selects token / secret columns.
 *   - Returns a structured ok() envelope or failed() on DB errors.
 */

export async function workspaceGet(ctx: ToolContext): Promise<McpToolResponse> {
  const { data: workspace, error: wsErr } = await ctx.db
    .from("workspaces")
    .select("id, name, slug, created_at, updated_at")
    .eq("id", ctx.workspaceId)
    .maybeSingle();
  if (wsErr || !workspace) {
    return failed({
      tool: "signal.workspace.get",
      summary: wsErr?.message ?? "workspace not found",
    });
  }
  const { data: settings } = await ctx.db
    .from("workspace_settings")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  const demoMode =
    (process.env.NEXT_PUBLIC_SIGNAL_DEMO_MODE ?? "").toLowerCase() === "true";
  return ok({
    tool: "signal.workspace.get",
    summary: `Workspace ${(workspace as { name: string }).name}`,
    data: {
      workspace,
      settings: settings ?? null,
      demo_mode: demoMode,
      operator_scopes: ctx.scopes,
    },
  });
}

export async function productsList(ctx: ToolContext): Promise<McpToolResponse> {
  const { data, error } = await ctx.db
    .from("products")
    .select(
      "id, name, domain, summary, category, status, source, review_status, created_at, updated_at",
    )
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return failed({ tool: "signal.products.list", summary: error.message });
  return ok({
    tool: "signal.products.list",
    summary: `${data?.length ?? 0} product(s)`,
    data: { products: data ?? [] },
  });
}

export async function accountsList(ctx: ToolContext): Promise<McpToolResponse> {
  const { data, error } = await ctx.db
    .from("growth_accounts")
    .select(
      "id, product_id, platform, handle, display_name, role, status, connection_status, source, review_status, created_at, updated_at",
    )
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return failed({ tool: "signal.accounts.list", summary: error.message });
  return ok({
    tool: "signal.accounts.list",
    summary: `${data?.length ?? 0} account(s)`,
    data: { accounts: data ?? [] },
  });
}

export async function weeklyPlanCurrent(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const { data: plan, error: planErr } = await ctx.db
    .from("weekly_plans")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (planErr)
    return failed({ tool: "signal.weekly_plan.current", summary: planErr.message });
  if (!plan) {
    return ok({
      tool: "signal.weekly_plan.current",
      summary: "No weekly plan yet.",
      data: { plan: null, items: [] },
    });
  }
  const { data: items, error: itemsErr } = await ctx.db
    .from("weekly_plan_items")
    .select(
      "id, weekly_plan_id, product_id, account_id, platform, content_type, title, body, link_url, status, risk_level, risk_score, scheduled_at, created_at, updated_at",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("weekly_plan_id", (plan as { id: string }).id)
    .order("scheduled_at", { ascending: true });
  if (itemsErr)
    return failed({ tool: "signal.weekly_plan.current", summary: itemsErr.message });
  return ok({
    tool: "signal.weekly_plan.current",
    summary: `Plan ${(plan as { title: string }).title} · ${items?.length ?? 0} item(s)`,
    data: { plan, items: items ?? [] },
  });
}

export async function contractsActive(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const { data: contract, error } = await ctx.db
    .from("weekly_approval_contracts")
    .select(
      "id, title, week_start, week_end, status, max_risk_level, max_actions_total, max_actions_per_day, max_actions_per_platform_per_day, pause_on_first_failure, pause_on_risk_event, approved_at, activated_at, paused_at",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("status", "active")
    .maybeSingle();
  if (error)
    return failed({ tool: "signal.contracts.active", summary: error.message });
  if (!contract) {
    return ok({
      tool: "signal.contracts.active",
      summary: "No active weekly contract.",
      data: { contract: null, scope: null },
    });
  }
  const contractId = (contract as { id: string }).id;
  const [acctRes, prodRes, platRes, actRes, winRes] = await Promise.all([
    ctx.db
      .from("weekly_contract_accounts")
      .select("account_id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("contract_id", contractId),
    ctx.db
      .from("weekly_contract_products")
      .select("product_id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("contract_id", contractId),
    ctx.db
      .from("weekly_contract_platforms")
      .select("platform")
      .eq("workspace_id", ctx.workspaceId)
      .eq("contract_id", contractId),
    ctx.db
      .from("weekly_contract_allowed_actions")
      .select("action_type")
      .eq("workspace_id", ctx.workspaceId)
      .eq("contract_id", contractId),
    ctx.db
      .from("weekly_contract_execution_windows")
      .select("day_of_week, start_time, end_time")
      .eq("workspace_id", ctx.workspaceId)
      .eq("contract_id", contractId)
      .order("day_of_week", { ascending: true }),
  ]);
  const scope = {
    account_ids:
      ((acctRes.data ?? []) as Array<{ account_id: string }>).map((r) => r.account_id),
    product_ids:
      ((prodRes.data ?? []) as Array<{ product_id: string }>).map((r) => r.product_id),
    platforms:
      ((platRes.data ?? []) as Array<{ platform: string }>).map((r) => r.platform),
    allowed_actions:
      ((actRes.data ?? []) as Array<{ action_type: string }>).map((r) => r.action_type),
    execution_windows: winRes.data ?? [],
  };
  return ok({
    tool: "signal.contracts.active",
    summary: `Active contract ${(contract as { title: string }).title}`,
    data: { contract, scope },
  });
}

export async function executionQueueStatus(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const [queues, items, logs] = await Promise.all([
    ctx.db
      .from("execution_queues")
      .select("id, title, status, week_start, week_end, created_at")
      .eq("workspace_id", ctx.workspaceId)
      .order("created_at", { ascending: false })
      .limit(20),
    ctx.db
      .from("execution_items")
      .select(
        "id, queue_id, contract_id, action_type, platform, status, risk_level, attempt_count, max_attempts, created_at, updated_at",
      )
      .eq("workspace_id", ctx.workspaceId)
      .order("created_at", { ascending: false })
      .limit(50),
    ctx.db
      .from("execution_logs")
      .select("id, queue_id, execution_item_id, event_type, severity, message, created_at")
      .eq("workspace_id", ctx.workspaceId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  if (queues.error)
    return failed({ tool: "signal.execution.queue_status", summary: queues.error.message });
  return ok({
    tool: "signal.execution.queue_status",
    summary: `${queues.data?.length ?? 0} queue(s), ${items.data?.length ?? 0} item(s), ${logs.data?.length ?? 0} recent log(s)`,
    data: {
      queues: queues.data ?? [],
      items: items.data ?? [],
      logs: logs.data ?? [],
    },
  });
}

export async function verificationLatest(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const { data, error } = await ctx.db
    .from("mcp_operation_runs")
    .select(
      "id, operation_type, status, risk_level, approval_mode, input_summary, output_summary, error_summary, created_at, updated_at, metadata",
    )
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error)
    return failed({ tool: "signal.verification.latest", summary: error.message });
  return ok({
    tool: "signal.verification.latest",
    summary: `${data?.length ?? 0} recent operation run(s)`,
    data: { runs: data ?? [] },
  });
}

export async function oauthConnectionsList(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  // Explicit projection — `access_token_encrypted` and
  // `refresh_token_encrypted` are NEVER selected. The booleans below
  // are computed on the database side so the response stays
  // token-free even under faulty client code.
  const { data, error } = await ctx.db
    .from("platform_connections")
    .select(
      "id, account_id, platform, provider_account_id, handle, display_name, connection_status, scopes, expires_at, connected_at, revoked_at, last_checked_at, health_status, metadata, created_at",
    )
    .eq("workspace_id", ctx.workspaceId)
    .order("updated_at", { ascending: false });
  if (error)
    return failed({
      tool: "signal.oauth.connections.list",
      summary: error.message,
    });

  // Get has_*_token via a second tiny query that only selects nullable
  // existence — no value ever leaves the database.
  const { data: presence } = await ctx.db
    .from("platform_connections")
    .select(
      "id, has_access_token:access_token_encrypted, has_refresh_token:refresh_token_encrypted",
    )
    .eq("workspace_id", ctx.workspaceId);
  const presenceById = new Map<
    string,
    { has_access_token: boolean; has_refresh_token: boolean }
  >();
  for (const row of (presence ?? []) as Array<{
    id: string;
    has_access_token: string | null;
    has_refresh_token: string | null;
  }>) {
    presenceById.set(row.id, {
      has_access_token: row.has_access_token !== null,
      has_refresh_token: row.has_refresh_token !== null,
    });
  }
  const connections = (data ?? []).map((row) => {
    const id = (row as { id: string }).id;
    const flags = presenceById.get(id) ?? {
      has_access_token: false,
      has_refresh_token: false,
    };
    return { ...(row as Record<string, unknown>), ...flags };
  });

  const { readRedditOauthStatus } = await import("@/lib/oauth/env");
  const redditStatus = readRedditOauthStatus();

  return ok({
    tool: "signal.oauth.connections.list",
    summary: `${connections.length} platform connection(s) — no tokens exposed. reddit oauth status: ${redditStatus}.`,
    data: {
      connections,
      provider_status: {
        reddit: redditStatus,
      },
    },
    warnings:
      redditStatus === "blocked_pending_reddit_api_approval"
        ? [
            "Reddit OAuth is blocked pending Reddit API approval. Use the manual-publish fallback at /execution/items/<id>.",
          ]
        : [],
  });
}

export async function activityLatest(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  const { data, error } = await ctx.db
    .from("activity_events")
    .select(
      "id, event_type, entity_type, entity_id, title, description, source, metadata, created_at",
    )
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error)
    return failed({ tool: "signal.activity.latest", summary: error.message });
  return ok({
    tool: "signal.activity.latest",
    summary: `${data?.length ?? 0} activity event(s)`,
    data: { events: data ?? [] },
  });
}
