import "server-only";
import { ok, failed, type McpToolResponse } from "../responses";
import type { ToolContext } from "../tool-context";
import type {
  AccountsPrepareArgs,
  ImportsPrepareMappingArgs,
  ProductsPrepareArgs,
  ReportsSubmitArgs,
  WeeklyPlanPrepareItemArgs,
} from "../schemas";

/**
 * Phase F0 — prepare/write-pending tools.
 *
 * Every write lands as pending_review (or status='draft' for plan
 * items) and tagged with source='mcp_operation'. None of these tools
 * can confirm, activate, or publish anything.
 */

export async function productsPrepare(
  ctx: ToolContext,
  args: ProductsPrepareArgs,
): Promise<McpToolResponse> {
  const { data, error } = await ctx.db
    .from("products")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        name: args.name,
        domain: args.domain,
        summary: args.summary,
        category: args.category,
        status: "active",
        source: "mcp_operation",
        review_status: "pending_review",
      } as never,
    )
    .select("id, name, status, source, review_status, created_at")
    .single();
  if (error || !data)
    return failed({
      tool: "signal.products.prepare",
      summary: error?.message ?? "insert_failed",
    });
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.product_profile_create_pending",
      entity_type: "product",
      entity_id: (data as { id: string }).id,
      title: `MCP prepared product: ${args.name}`,
      description: args.source_note ?? null,
      source: "mcp_operation",
      metadata: { operator_token_id: ctx.operatorTokenId },
    } as never,
  );
  return ok({
    tool: "signal.products.prepare",
    summary: `Created product as pending_review.`,
    data: { product: data },
    requiresUserApproval: true,
  });
}

export async function accountsPrepare(
  ctx: ToolContext,
  args: AccountsPrepareArgs,
): Promise<McpToolResponse> {
  if (args.product_id) {
    // Verify the product belongs to this workspace.
    const { data: productCheck } = await ctx.db
      .from("products")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", args.product_id)
      .maybeSingle();
    if (!productCheck) {
      return failed({
        tool: "signal.accounts.prepare",
        summary: "product_id does not belong to this workspace",
      });
    }
  }
  const { data, error } = await ctx.db
    .from("growth_accounts")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        product_id: args.product_id,
        platform: args.platform,
        handle: args.handle,
        display_name: args.display_name,
        role: null,
        status: "planned",
        connection_status: "not_connected",
        source: "mcp_operation",
        review_status: "pending_review",
      } as never,
    )
    .select(
      "id, platform, handle, display_name, status, connection_status, source, review_status, created_at",
    )
    .single();
  if (error || !data)
    return failed({
      tool: "signal.accounts.prepare",
      summary: error?.message ?? "insert_failed",
    });
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.account_profile_create_pending",
      entity_type: "growth_account",
      entity_id: (data as { id: string }).id,
      title: `MCP prepared ${args.platform} account: ${args.display_name}`,
      description: args.source_note ?? null,
      source: "mcp_operation",
      metadata: { operator_token_id: ctx.operatorTokenId },
    } as never,
  );
  return ok({
    tool: "signal.accounts.prepare",
    summary: "Created growth account as pending_review.",
    data: { account: data },
    requiresUserApproval: true,
  });
}

export async function weeklyPlanPrepareItem(
  ctx: ToolContext,
  args: WeeklyPlanPrepareItemArgs,
): Promise<McpToolResponse> {
  // Find or create the current weekly plan.
  const { data: existing } = await ctx.db
    .from("weekly_plans")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .order("week_start", { ascending: false })
    .limit(1)
    .maybeSingle();

  let planId = (existing as { id: string } | null)?.id ?? null;
  if (!planId) {
    const weekStart = isoMonday(new Date());
    const { data: plan, error: planErr } = await ctx.db
      .from("weekly_plans")
      .insert(
        {
          workspace_id: ctx.workspaceId,
          title: `Week of ${weekStart}`,
          week_start: weekStart,
        } as never,
      )
      .select("id")
      .single();
    if (planErr || !plan)
      return failed({
        tool: "signal.weekly_plan.prepare_item",
        summary: planErr?.message ?? "plan_insert_failed",
      });
    planId = (plan as { id: string }).id;
  }

  const { data, error } = await ctx.db
    .from("weekly_plan_items")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        weekly_plan_id: planId,
        product_id: args.product_id,
        account_id: args.account_id,
        platform: args.platform,
        content_type: args.content_type,
        title: args.title,
        body: args.body,
        risk_score: args.risk_score,
        scheduled_at: args.scheduled_at,
        status: "draft",
        metadata: { source: "mcp_operation", operator_token_id: ctx.operatorTokenId },
      } as never,
    )
    .select(
      "id, weekly_plan_id, platform, content_type, title, status, risk_score, scheduled_at, created_at",
    )
    .single();
  if (error || !data)
    return failed({
      tool: "signal.weekly_plan.prepare_item",
      summary: error?.message ?? "item_insert_failed",
    });

  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.weekly_plan_item_prepared",
      entity_type: "weekly_plan_item",
      entity_id: (data as { id: string }).id,
      title: `MCP prepared plan item: ${args.title}`,
      description: args.platform ? `Platform: ${args.platform}` : null,
      source: "mcp_operation",
      metadata: { operator_token_id: ctx.operatorTokenId },
    } as never,
  );
  return ok({
    tool: "signal.weekly_plan.prepare_item",
    summary: "Created weekly_plan_item as draft.",
    data: { item: data },
    requiresUserApproval: true,
  });
}

export async function importsPrepareMapping(
  ctx: ToolContext,
  args: ImportsPrepareMappingArgs,
): Promise<McpToolResponse> {
  const operationType =
    args.import_type === "product"
      ? "product_profile_suggest"
      : "account_profile_suggest";
  const { data, error } = await ctx.db
    .from("mcp_operation_runs")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        operation_type: operationType,
        risk_level: "remote_write",
        approval_mode: "approval_required",
        status: "pending_approval",
        input_summary: `MCP imports.prepare_mapping (${args.raw_text.length} chars)`,
        output_summary: JSON.stringify({
          import_type: args.import_type,
          extracted_fields: args.extracted_fields ?? {},
          confidence: args.confidence,
          warnings: args.warnings ?? [],
        }).slice(0, 4000),
        requires_user_approval: true,
        metadata: {
          source: "mcp_server",
          operator_token_id: ctx.operatorTokenId,
          import_type: args.import_type,
          source_length: args.raw_text.length,
        },
      } as never,
    )
    .select("id")
    .single();
  if (error || !data)
    return failed({
      tool: "signal.imports.prepare_mapping",
      summary: error?.message ?? "operation_insert_failed",
    });
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.import_mapping_prepared",
      entity_type: "mcp_operation_run",
      entity_id: (data as { id: string }).id,
      title: `MCP prepared ${args.import_type} import mapping`,
      description: `${Object.keys(args.extracted_fields ?? {}).length} extracted field(s)`,
      source: "mcp_operation",
      metadata: { operator_token_id: ctx.operatorTokenId },
    } as never,
  );
  return ok({
    tool: "signal.imports.prepare_mapping",
    summary: `Recorded ${args.import_type} import mapping as pending_approval.`,
    data: { operation_run: data },
    requiresUserApproval: true,
  });
}

export async function reportsSubmit(
  ctx: ToolContext,
  args: ReportsSubmitArgs,
): Promise<McpToolResponse> {
  const { data, error } = await ctx.db
    .from("mcp_operation_runs")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        operation_type: "smoke_test_run",
        risk_level: "safe_read",
        approval_mode: "no_approval_needed",
        status: "completed",
        input_summary: `MCP report submission: ${args.report_type}`,
        output_summary: args.summary.slice(0, 4000),
        requires_user_approval: false,
        metadata: {
          source: "mcp_server",
          operator_token_id: ctx.operatorTokenId,
          report_type: args.report_type,
          checks: args.checks,
          recommended_next_action: args.recommended_next_action,
        },
      } as never,
    )
    .select("id")
    .single();
  if (error || !data)
    return failed({
      tool: "signal.reports.submit",
      summary: error?.message ?? "report_insert_failed",
    });
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.report_submitted",
      entity_type: "mcp_operation_run",
      entity_id: (data as { id: string }).id,
      title: `MCP report submitted: ${args.report_type}`,
      description: args.summary.slice(0, 200),
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        check_count: args.checks?.length ?? 0,
      },
    } as never,
  );
  return ok({
    tool: "signal.reports.submit",
    summary: "Operator report recorded.",
    data: { operation_run: data, check_count: args.checks?.length ?? 0 },
  });
}

function isoMonday(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}
