import "server-only";
import { ok, failed, type McpToolResponse } from "../responses";
import type { ToolContext } from "../tool-context";
import type {
  AccountsPrepareArgs,
  ImportsPrepareMappingArgs,
  ProductsPrepareArgs,
  ReportsSubmitArgs,
  WeeklyPlanAttachCreativeArgs,
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

const ACCOUNT_SELECT_COLUMNS =
  "id, platform, handle, display_name, voice_profile, product_id, status, connection_status, source, review_status, created_at";

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

  const reviewStatus = args.review_status ?? "pending_review";

  // Idempotency — if an identity already exists for this
  // (workspace, platform, handle) tuple, update it in place instead of
  // creating a duplicate. Handle is the natural uniqueness key the UI
  // uses to identify an account; null handle means "the unhandled
  // identity for that platform" and is also matched.
  const existingQuery = ctx.db
    .from("growth_accounts")
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq("workspace_id", ctx.workspaceId)
    .eq("platform", args.platform)
    .neq("status", "archived");
  const { data: existing } = await (args.handle
    ? existingQuery.eq("handle", args.handle)
    : existingQuery.is("handle", null)
  ).maybeSingle();

  if (existing) {
    const existingId = (existing as { id: string }).id;
    const patch: Record<string, unknown> = {
      display_name: args.display_name,
      review_status: reviewStatus,
    };
    if (args.voice_profile !== undefined) patch.voice_profile = args.voice_profile;
    if (args.product_id !== undefined) patch.product_id = args.product_id;
    const { data: updated, error: updateError } = await ctx.db
      .from("growth_accounts")
      .update(patch as never)
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", existingId)
      .select(ACCOUNT_SELECT_COLUMNS)
      .single();
    if (updateError || !updated)
      return failed({
        tool: "signal.accounts.prepare",
        summary: updateError?.message ?? "update_failed",
      });
    await ctx.db.from("activity_events").insert(
      {
        workspace_id: ctx.workspaceId,
        event_type: "mcp.account_profile_updated",
        entity_type: "growth_account",
        entity_id: existingId,
        title: `MCP updated ${args.platform} account: ${args.display_name}`,
        description: args.source_note ?? null,
        source: "mcp_operation",
        metadata: { operator_token_id: ctx.operatorTokenId },
      } as never,
    );
    return ok({
      tool: "signal.accounts.prepare",
      summary:
        reviewStatus === "confirmed"
          ? "Updated existing growth account (confirmed)."
          : "Updated existing growth account (pending_review).",
      data: { account: updated, idempotent: true },
      requiresUserApproval: reviewStatus !== "confirmed",
    });
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
        voice_profile: args.voice_profile ?? null,
        status: "planned",
        connection_status: "not_connected",
        source: "mcp_operation",
        review_status: reviewStatus,
      } as never,
    )
    .select(ACCOUNT_SELECT_COLUMNS)
    .single();
  if (error || !data)
    return failed({
      tool: "signal.accounts.prepare",
      summary: error?.message ?? "insert_failed",
    });
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type:
        reviewStatus === "confirmed"
          ? "mcp.account_profile_created"
          : "mcp.account_profile_create_pending",
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
    summary:
      reviewStatus === "confirmed"
        ? "Created growth account (confirmed)."
        : "Created growth account as pending_review.",
    data: { account: data, idempotent: false },
    requiresUserApproval: reviewStatus !== "confirmed",
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

  // Default is `pending_approval` so MCP-created items land in the
  // operator's /approval-queue. Callers that want a private holding
  // pen can pass `save_as_draft: true`.
  const targetStatus = args.save_as_draft ? "draft" : "pending_approval";
  const itemMetadata: Record<string, unknown> = {
    source: "mcp_operation",
    operator_token_id: ctx.operatorTokenId,
  };
  if (args.timezone) itemMetadata.timezone = args.timezone;
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
        status: targetStatus,
        metadata: itemMetadata,
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

  // Phase F1: posts require a creative. If the operator provided
  // creative fields, attach a real one; otherwise drop a `planned`
  // placeholder so the approval queue can show "creative missing" UX.
  const itemId = (data as { id: string }).id;
  const isPost = (args.content_type ?? "").toLowerCase() === "post";
  const creativeRequired = args.creative_required ?? isPost;
  let creativeRow: unknown = null;
  if (creativeRequired) {
    const sourceType = args.creative_source_type ?? "planned";
    const creativeType = args.creative_type ?? "image";
    const status = sourceType === "planned" ? "planned" : "pending_review";
    const { data: cdata } = await ctx.db
      .from("weekly_plan_item_creatives")
      .insert(
        {
          workspace_id: ctx.workspaceId,
          weekly_plan_item_id: itemId,
          creative_type: creativeType,
          source_type: sourceType,
          source_url: args.creative_source_url,
          asset_url: args.creative_asset_url,
          prompt: args.creative_prompt,
          alt_text: args.creative_alt_text,
          license: args.creative_license,
          attribution: args.creative_attribution,
          risk_notes: args.creative_risk_notes,
          status,
          metadata: {
            source: "mcp_operation",
            operator_token_id: ctx.operatorTokenId,
          },
        } as never,
      )
      .select(
        "id, creative_type, source_type, status, alt_text, license, attribution",
      )
      .single();
    creativeRow = cdata ?? null;
  }

  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.weekly_plan_item_prepared",
      entity_type: "weekly_plan_item",
      entity_id: itemId,
      title: `MCP prepared plan item: ${args.title}`,
      description: [
        args.platform ? `Platform: ${args.platform}` : null,
        `Status: ${targetStatus}`,
        creativeRow ? "Creative attached" : null,
      ]
        .filter(Boolean)
        .join(" · "),
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        status: targetStatus,
        creative_present: Boolean(creativeRow),
      },
    } as never,
  );
  return ok({
    tool: "signal.weekly_plan.prepare_item",
    summary:
      targetStatus === "pending_approval"
        ? "Created weekly_plan_item as pending_approval (visible in /approval-queue)."
        : "Created weekly_plan_item as draft (not in approval queue).",
    data: { item: data, creative: creativeRow },
    requiresUserApproval: targetStatus === "pending_approval",
  });
}

export async function weeklyPlanAttachCreative(
  ctx: ToolContext,
  args: WeeklyPlanAttachCreativeArgs,
): Promise<McpToolResponse> {
  // Verify the item belongs to this workspace.
  const { data: itemCheck } = await ctx.db
    .from("weekly_plan_items")
    .select("id, content_type")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.weekly_plan_item_id)
    .maybeSingle();
  if (!itemCheck) {
    return failed({
      tool: "signal.weekly_plan.attach_creative",
      summary: "weekly_plan_item not found in this workspace",
    });
  }
  const status = args.source_type === "planned" ? "planned" : "pending_review";
  const { data, error } = await ctx.db
    .from("weekly_plan_item_creatives")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        weekly_plan_item_id: args.weekly_plan_item_id,
        creative_type: args.creative_type,
        source_type: args.source_type,
        source_url: args.source_url,
        asset_url: args.asset_url,
        prompt: args.prompt,
        alt_text: args.alt_text,
        license: args.license,
        attribution: args.attribution,
        risk_notes: args.risk_notes,
        status,
        metadata: {
          source: "mcp_operation",
          operator_token_id: ctx.operatorTokenId,
        },
      } as never,
    )
    .select(
      "id, weekly_plan_item_id, creative_type, source_type, status, alt_text, license, attribution",
    )
    .single();
  if (error || !data)
    return failed({
      tool: "signal.weekly_plan.attach_creative",
      summary: error?.message ?? "creative_insert_failed",
    });
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.weekly_plan_item_creative_attached",
      entity_type: "weekly_plan_item_creative",
      entity_id: (data as { id: string }).id,
      title: `MCP attached creative (${args.creative_type} · ${args.source_type})`,
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        weekly_plan_item_id: args.weekly_plan_item_id,
      },
    } as never,
  );
  return ok({
    tool: "signal.weekly_plan.attach_creative",
    summary: `Attached creative as ${status}.`,
    data: { creative: data },
    requiresUserApproval: false,
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
