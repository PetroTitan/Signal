import "server-only";

/**
 * Signal MCP — planning + draft-generation tools.
 *
 * Exposes the same internal services the compose UI already uses
 * (`generateDraft`, plan-item creation, activity logging) as
 * audited MCP tools so Claude can operate Signal as a publishing
 * assistant. Every output lands in `draft` state — these tools
 * never publish, never schedule live posts, never bypass operator
 * approval.
 *
 * Tools:
 *   - signal.generate_draft          — one identity, one draft
 *   - signal.generate_weekly_plan    — multiple identities × topics
 *   - signal.generate_multiweek_plan — multiple weeks of plans
 *   - signal.identities.update       — patch identity fields
 *
 * Aliases (registered in tool-registry.ts):
 *   - signal.products.create   → existing productsPrepare
 *   - signal.identities.create → existing accountsPrepare
 */

import { generateDraft } from "@/core/generation/generate-draft";
import { extractHook } from "@/core/generation/assemble-platform-native-result";
import type {
  GenerateDraftArgs,
  GenerateMultiweekPlanArgs,
  GenerateWeeklyPlanArgs,
  IdentitiesUpdateArgs,
  WeeklyPlanTopic,
  WeeklyPlanUpdateItemArgs,
} from "../schemas";
import { failed, ok, type McpToolResponse } from "../responses";
import type { ToolContext } from "../tool-context";

const ACCOUNT_SELECT_COLUMNS =
  "id, platform, handle, display_name, voice_profile, product_id, status, connection_status, source, review_status, created_at";

// =====================================================================
// Helpers
// =====================================================================

function isoMonday(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Find an existing weekly_plans row for (workspace, week_start), or
 * create one. Idempotent on (workspace, week_start).
 */
async function getOrCreateWeeklyPlan(
  ctx: ToolContext,
  weekStart: string,
): Promise<{ id: string } | { error: string }> {
  const { data: existing } = await ctx.db
    .from("weekly_plans")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("week_start", weekStart)
    .maybeSingle();
  if (existing) return { id: (existing as { id: string }).id };
  const { data, error } = await ctx.db
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
  if (error || !data)
    return { error: error?.message ?? "weekly_plan_insert_failed" };
  return { id: (data as { id: string }).id };
}

interface DraftPersistOutcome {
  plan_item_id: string;
  platform: string;
  identity_id: string;
  status: string;
  envelope: Record<string, unknown>;
  warnings: ReadonlyArray<string>;
  review_url: string;
}

/**
 * The single source of truth for "generate + persist one draft."
 * Used by all three generation tools. Returns either an outcome or
 * a structured failure (operator-facing reason).
 */
async function generateAndPersistOneDraft(input: {
  ctx: ToolContext;
  toolName: string;
  identityId: string;
  weeklyPlanId: string;
  topic: WeeklyPlanTopic;
  toneAdjustment: string | null;
  schedulePreference: string | null;
}): Promise<{ outcome: DraftPersistOutcome } | { error: string }> {
  const { ctx, toolName, identityId, weeklyPlanId, topic } = input;

  // Workspace-scoped identity check — refuses cross-workspace ids
  // even when the caller has the scope.
  const { data: identity } = await ctx.db
    .from("growth_accounts")
    .select("id, platform, handle, display_name, product_id, status")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", identityId)
    .neq("status", "archived")
    .maybeSingle();
  if (!identity) {
    return {
      error: `identity_not_found_or_archived:${identityId}`,
    };
  }

  // Call the SAME generateDraft the compose UI uses. The
  // PlatformNativeDraft envelope is populated on every return path
  // (PR #75); failure paths still surface a complete envelope so the
  // plan item carries creativeDirection even when generation
  // produced only a seeded body.
  //
  // We pass `ctx.db` — the service-role client the MCP dispatcher
  // hands every tool — so the identity-context lookup inside
  // generateDraft doesn't fall back to a cookie-aware server client
  // (which has no session on bearer-token MCP requests and would
  // return null, dropping us to the fallback envelope).
  const result = await generateDraft({
    workspaceId: ctx.workspaceId,
    db: ctx.db,
    generation: {
      weeklyPlanId,
      identityId,
      platform: (identity as { platform: string }).platform,
      productId: (identity as { product_id: string | null }).product_id,
      topic: topic.topic,
      goal: topic.goal,
      cta: topic.cta,
      sourceUrl: topic.source_url,
      toneAdjustment: input.toneAdjustment,
      schedulePreference: input.schedulePreference,
    },
  });

  const envelope = result.platformNativeDraft;
  const platform = envelope.platform;

  // Build the metadata payload mirroring _generate-draft-action.ts.
  const planItemMetadata: Record<string, unknown> = {
    source: "mcp_operation",
    operator_token_id: ctx.operatorTokenId,
    generated_by: "signal_mcp_planning_tools",
    identity_id: identityId,
    product_id: (identity as { product_id: string | null }).product_id,
    generation_topic: topic.topic,
    generation_goal: topic.goal,
    generation_cta: topic.cta,
    generation_source_url: topic.source_url,
    generation_provider_used: result.providerUsed,
    generation_status: result.status,
    safety_notes: result.draft.safetyNotes,
    requires_founder_review: true,
    platform_native_draft: {
      platform: envelope.platform,
      title: envelope.title,
      hook: envelope.hook,
      cta: envelope.cta,
      format: envelope.format,
      creative_direction: {
        media_required: envelope.creativeDirection.mediaRequired,
        media_type: envelope.creativeDirection.mediaType,
        media_prompt_or_brief: envelope.creativeDirection.mediaPromptOrBrief,
        media_risk_notes: envelope.creativeDirection.mediaRiskNotes,
      },
      risk_level: envelope.riskLevel,
      warnings: envelope.warnings,
      transformation_notes: envelope.transformationNotes,
    },
  };
  if (result.draft.summary) planItemMetadata.summary = result.draft.summary;
  if (result.draft.tags.length > 0) planItemMetadata.tags = result.draft.tags;
  if (topic.source_url) planItemMetadata.canonical_url = topic.source_url;

  const { data: item, error: insertError } = await ctx.db
    .from("weekly_plan_items")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        weekly_plan_id: weeklyPlanId,
        product_id: (identity as { product_id: string | null }).product_id,
        account_id: identityId,
        platform,
        content_type: "post",
        title: result.draft.title,
        body: result.draft.bodyMarkdown,
        status: "draft",
        metadata: planItemMetadata,
      } as never,
    )
    .select("id, status")
    .single();
  if (insertError || !item) {
    return {
      error: insertError?.message ?? "plan_item_insert_failed",
    };
  }

  // Audit row for visibility — same shape as
  // _generate-draft-action.ts records.
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "draft.generated",
      entity_type: "weekly_plan_item",
      entity_id: (item as { id: string }).id,
      title: `MCP generated draft for ${platform}`,
      description: result.providerUsed
        ? "Claude (MCP) generated a draft via signal_mcp_planning_tools."
        : "Claude (MCP) seeded a draft (no AI provider connected).",
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        identity_id: identityId,
        platform,
        provider_used: result.providerUsed,
        generation_status: result.status,
        tool: toolName,
      },
    } as never,
  );

  const planItemId = (item as { id: string }).id;

  return {
    outcome: {
      plan_item_id: planItemId,
      platform,
      identity_id: identityId,
      status: (item as { status: string }).status,
      envelope: planItemMetadata.platform_native_draft as Record<string, unknown>,
      warnings: envelope.warnings,
      review_url: `/weekly-plan?focus=${encodeURIComponent(planItemId)}`,
    },
  };
}

// =====================================================================
// Tool 1 — signal.generate_draft
// =====================================================================

export async function generateDraftTool(
  ctx: ToolContext,
  args: GenerateDraftArgs,
): Promise<McpToolResponse> {
  const weekStart = args.week_start ?? isoMonday(new Date());
  const planResult = await getOrCreateWeeklyPlan(ctx, weekStart);
  if ("error" in planResult) {
    return failed({
      tool: "signal.generate_draft",
      summary: planResult.error,
    });
  }

  const draftResult = await generateAndPersistOneDraft({
    ctx,
    toolName: "signal.generate_draft",
    identityId: args.identity_id,
    weeklyPlanId: planResult.id,
    topic: {
      topic: args.topic,
      goal: args.goal,
      cta: args.cta,
      source_url: args.source_url,
    },
    toneAdjustment: args.tone_adjustment,
    schedulePreference: args.schedule_preference,
  });
  if ("error" in draftResult) {
    return failed({
      tool: "signal.generate_draft",
      summary: draftResult.error,
    });
  }

  const o = draftResult.outcome;
  return ok({
    tool: "signal.generate_draft",
    summary: `Created draft plan item for ${o.platform}. Operator review required.`,
    data: {
      plan_item_id: o.plan_item_id,
      platform: o.platform,
      identity_id: o.identity_id,
      status: o.status,
      weekly_plan_id: planResult.id,
      week_start: weekStart,
      platform_native_draft: o.envelope,
      review_url: o.review_url,
    },
    warnings: [...o.warnings],
    requiresUserApproval: true,
  });
}

// =====================================================================
// Tool 2 — signal.generate_weekly_plan
// =====================================================================

export async function generateWeeklyPlanTool(
  ctx: ToolContext,
  args: GenerateWeeklyPlanArgs,
): Promise<McpToolResponse> {
  // Workspace-scoped product check.
  const { data: product } = await ctx.db
    .from("products")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.product_id)
    .maybeSingle();
  if (!product) {
    return failed({
      tool: "signal.generate_weekly_plan",
      summary: "product_not_found_in_workspace",
    });
  }

  // Workspace-scoped identity batch check.
  const { data: identityRows } = await ctx.db
    .from("growth_accounts")
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq("workspace_id", ctx.workspaceId)
    .in("id", args.identity_ids as string[]);
  const foundIds = new Set(
    ((identityRows as { id: string }[] | null) ?? []).map((r) => r.id),
  );
  const missing = args.identity_ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return failed({
      tool: "signal.generate_weekly_plan",
      summary: `identities_not_found_in_workspace:${missing.join(",")}`,
    });
  }

  const planResult = await getOrCreateWeeklyPlan(ctx, args.week_start);
  if ("error" in planResult) {
    return failed({
      tool: "signal.generate_weekly_plan",
      summary: planResult.error,
    });
  }

  // Per-platform throttle if requested. Counts are reset each tool
  // invocation (no cross-call tracking).
  const platformCounts = new Map<string, number>();
  const outcomes: DraftPersistOutcome[] = [];
  const itemErrors: Array<{ identity_id: string; topic: string; error: string }> = [];

  for (const identityId of args.identity_ids) {
    for (const topic of args.topics) {
      // Look up the identity's platform from the batch result so
      // we can apply max_posts_per_platform before generation.
      const idRow = ((identityRows as { id: string; platform: string }[]) ?? []).find(
        (r) => r.id === identityId,
      );
      const platform = idRow?.platform ?? "unknown";
      const current = platformCounts.get(platform) ?? 0;
      if (
        args.max_posts_per_platform !== null &&
        current >= args.max_posts_per_platform
      ) {
        itemErrors.push({
          identity_id: identityId,
          topic: topic.topic,
          error: `platform_cap_reached:${platform}:${args.max_posts_per_platform}`,
        });
        continue;
      }
      const draftResult = await generateAndPersistOneDraft({
        ctx,
        toolName: "signal.generate_weekly_plan",
        identityId,
        weeklyPlanId: planResult.id,
        topic,
        toneAdjustment: args.strategic_theme,
        schedulePreference: null,
      });
      if ("error" in draftResult) {
        itemErrors.push({
          identity_id: identityId,
          topic: topic.topic,
          error: draftResult.error,
        });
      } else {
        outcomes.push(draftResult.outcome);
        platformCounts.set(platform, current + 1);
      }
    }
  }

  if (outcomes.length === 0) {
    return failed({
      tool: "signal.generate_weekly_plan",
      summary: "no_items_generated",
      warnings: itemErrors.map((e) => `${e.identity_id}/${e.topic}: ${e.error}`),
    });
  }

  const warnings: string[] = [];
  for (const o of outcomes) {
    for (const w of o.warnings) warnings.push(`${o.platform}: ${w}`);
  }
  for (const e of itemErrors) {
    warnings.push(`skipped ${e.identity_id}/${e.topic}: ${e.error}`);
  }

  return ok({
    tool: "signal.generate_weekly_plan",
    summary: `Generated ${outcomes.length} draft item(s) for week starting ${args.week_start}. Operator review required.`,
    data: {
      weekly_plan_id: planResult.id,
      week_start: args.week_start,
      product_id: args.product_id,
      items: outcomes.map((o) => ({
        plan_item_id: o.plan_item_id,
        platform: o.platform,
        identity_id: o.identity_id,
        status: o.status,
        platform_native_draft: o.envelope,
        review_url: o.review_url,
      })),
      review_url: "/weekly-plan",
    },
    warnings,
    requiresUserApproval: true,
  });
}

// =====================================================================
// Tool 3 — signal.generate_multiweek_plan
// =====================================================================

export async function generateMultiweekPlanTool(
  ctx: ToolContext,
  args: GenerateMultiweekPlanArgs,
): Promise<McpToolResponse> {
  // Workspace-scoped product check.
  const { data: product } = await ctx.db
    .from("products")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.product_id)
    .maybeSingle();
  if (!product) {
    return failed({
      tool: "signal.generate_multiweek_plan",
      summary: "product_not_found_in_workspace",
    });
  }

  const { data: identityRows } = await ctx.db
    .from("growth_accounts")
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq("workspace_id", ctx.workspaceId)
    .in("id", args.identity_ids as string[]);
  const foundIds = new Set(
    ((identityRows as { id: string }[] | null) ?? []).map((r) => r.id),
  );
  const missing = args.identity_ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return failed({
      tool: "signal.generate_multiweek_plan",
      summary: `identities_not_found_in_workspace:${missing.join(",")}`,
    });
  }

  const weeklyPlanIds: string[] = [];
  const reviewUrls: string[] = [];
  const allItems: DraftPersistOutcome[] = [];
  const itemErrors: Array<{ week: string; identity_id: string; topic: string; error: string }> = [];

  // Iterate weeks. Each week reuses the same topic list — the
  // strategic_theme is funneled through tone_adjustment so the LLM
  // gets the consistent through-line.
  for (let weekIdx = 0; weekIdx < args.number_of_weeks; weekIdx++) {
    const weekStart = isoMonday(
      new Date(`${addDaysIso(args.start_date, weekIdx * 7)}T00:00:00Z`),
    );
    const planResult = await getOrCreateWeeklyPlan(ctx, weekStart);
    if ("error" in planResult) {
      return failed({
        tool: "signal.generate_multiweek_plan",
        summary: `${weekStart}: ${planResult.error}`,
      });
    }
    weeklyPlanIds.push(planResult.id);
    reviewUrls.push(`/weekly-plan?week=${encodeURIComponent(weekStart)}`);

    const weekPlatformCounts = new Map<string, number>();

    for (const identityId of args.identity_ids) {
      for (const topic of args.topics_per_week) {
        const idRow = ((identityRows as { id: string; platform: string }[]) ?? []).find(
          (r) => r.id === identityId,
        );
        const platform = idRow?.platform ?? "unknown";
        const current = weekPlatformCounts.get(platform) ?? 0;
        if (
          args.max_posts_per_week !== null &&
          current >= args.max_posts_per_week
        ) {
          itemErrors.push({
            week: weekStart,
            identity_id: identityId,
            topic: topic.topic,
            error: `platform_cap_reached:${platform}:${args.max_posts_per_week}`,
          });
          continue;
        }
        const draftResult = await generateAndPersistOneDraft({
          ctx,
          toolName: "signal.generate_multiweek_plan",
          identityId,
          weeklyPlanId: planResult.id,
          topic,
          toneAdjustment: args.strategic_theme,
          schedulePreference: null,
        });
        if ("error" in draftResult) {
          itemErrors.push({
            week: weekStart,
            identity_id: identityId,
            topic: topic.topic,
            error: draftResult.error,
          });
        } else {
          allItems.push(draftResult.outcome);
          weekPlatformCounts.set(platform, current + 1);
        }
      }
    }
  }

  if (allItems.length === 0) {
    return failed({
      tool: "signal.generate_multiweek_plan",
      summary: "no_items_generated",
      warnings: itemErrors.map(
        (e) => `${e.week}/${e.identity_id}/${e.topic}: ${e.error}`,
      ),
    });
  }

  const warnings: string[] = [];
  for (const o of allItems) {
    for (const w of o.warnings) warnings.push(`${o.platform}: ${w}`);
  }
  for (const e of itemErrors) {
    warnings.push(`skipped ${e.week}/${e.identity_id}/${e.topic}: ${e.error}`);
  }

  return ok({
    tool: "signal.generate_multiweek_plan",
    summary: `Generated ${allItems.length} draft item(s) across ${weeklyPlanIds.length} week(s). Operator review required.`,
    data: {
      weekly_plan_ids: weeklyPlanIds,
      product_id: args.product_id,
      start_date: args.start_date,
      number_of_weeks: args.number_of_weeks,
      strategic_theme: args.strategic_theme,
      items: allItems.map((o) => ({
        plan_item_id: o.plan_item_id,
        platform: o.platform,
        identity_id: o.identity_id,
        status: o.status,
        platform_native_draft: o.envelope,
        review_url: o.review_url,
      })),
      review_urls: reviewUrls,
    },
    warnings,
    requiresUserApproval: true,
  });
}

// =====================================================================
// Tool 4 — signal.identities.update
// =====================================================================

export async function identitiesUpdateTool(
  ctx: ToolContext,
  args: IdentitiesUpdateArgs,
): Promise<McpToolResponse> {
  // Workspace-scoped identity lookup.
  const { data: existing } = await ctx.db
    .from("growth_accounts")
    .select(ACCOUNT_SELECT_COLUMNS)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.identity_id)
    .neq("status", "archived")
    .maybeSingle();
  if (!existing) {
    return failed({
      tool: "signal.identities.update",
      summary: "identity_not_found_in_workspace",
    });
  }

  // Optional product validation — must belong to this workspace.
  if (args.product_id !== undefined && args.product_id !== null) {
    const { data: productCheck } = await ctx.db
      .from("products")
      .select("id")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", args.product_id)
      .maybeSingle();
    if (!productCheck) {
      return failed({
        tool: "signal.identities.update",
        summary: "product_id_does_not_belong_to_this_workspace",
      });
    }
  }

  // Build the patch — only include keys the caller passed (preserves
  // existing values for anything they left untouched).
  const patch: Record<string, unknown> = {};
  if (args.display_name !== undefined) patch.display_name = args.display_name;
  if (args.handle !== undefined) patch.handle = args.handle;
  if (args.product_id !== undefined) patch.product_id = args.product_id;
  if (args.voice_profile !== undefined) patch.voice_profile = args.voice_profile;

  // Source-note is operator-facing context for the activity log, not
  // a column on the row.
  const { data: updated, error } = await ctx.db
    .from("growth_accounts")
    .update(patch as never)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.identity_id)
    .select(ACCOUNT_SELECT_COLUMNS)
    .single();
  if (error || !updated) {
    return failed({
      tool: "signal.identities.update",
      summary: error?.message ?? "update_failed",
    });
  }

  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.account_profile_updated",
      entity_type: "growth_account",
      entity_id: args.identity_id,
      title: `MCP updated identity: ${(updated as { display_name: string }).display_name}`,
      description: args.source_note ?? null,
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        updated_keys: Object.keys(patch),
      },
    } as never,
  );

  return ok({
    tool: "signal.identities.update",
    summary: "Updated identity. No credential or token changes.",
    data: { identity: updated },
    requiresUserApproval: false,
  });
}

// =====================================================================
// Tool 5 — signal.weekly_plan.update_item
// =====================================================================
//
// Edit body / title / CTA / creative brief / risk notes on an
// existing pre-approval plan item. The tool exists so Claude can
// correct a seeded placeholder body (no AI provider configured) or
// polish creative direction without forcing the operator to
// copy/paste in the UI.
//
// Hard refusals: any status past pending_approval. We never let
// MCP edit a row that has already been approved, scheduled,
// published, or rejected. That boundary is the operator's job.

const UPDATABLE_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "pending_approval",
]);

export async function weeklyPlanUpdateItemTool(
  ctx: ToolContext,
  args: WeeklyPlanUpdateItemArgs,
): Promise<McpToolResponse> {
  const TOOL = "signal.weekly_plan.update_item";

  // 1. Workspace-scoped lookup of the plan_item, including current
  //    metadata so we can preserve platform_native_draft on update.
  const { data: existing } = await ctx.db
    .from("weekly_plan_items")
    .select("id, workspace_id, status, platform, title, body, metadata")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.plan_item_id)
    .maybeSingle();
  if (!existing) {
    return failed({
      tool: TOOL,
      summary: "plan_item_not_found_in_workspace",
    });
  }

  // 2. Status gate. Anything past pending_approval is refused
  //    explicitly with the current status echoed back.
  const status = (existing as { status: string }).status;
  if (!UPDATABLE_STATUSES.has(status)) {
    return failed({
      tool: TOOL,
      summary: `plan_item_status_not_editable:${status}`,
    });
  }

  // 3. Build the column patch + the metadata patch separately.
  //    column patch: title and body live as their own columns
  //    metadata patch: deep-merged into metadata.platform_native_draft
  const columnPatch: Record<string, unknown> = {};
  const updatedFields: string[] = [];

  if (args.title !== undefined) {
    columnPatch.title = args.title;
    updatedFields.push("title");
  }
  if (args.body !== undefined) {
    columnPatch.body = args.body;
    updatedFields.push("body");
  }

  // Pick the creative-brief value. `creative_brief` is the primary
  // name; `media_prompt_or_brief` is accepted as an alias. If both
  // are set the parser would have kept both — primary wins here.
  const creativeBriefValue =
    args.creative_brief ?? args.media_prompt_or_brief ?? undefined;
  if (creativeBriefValue !== undefined) {
    updatedFields.push("creative_brief");
  }
  if (args.cta !== undefined) {
    updatedFields.push("cta");
  }
  if (args.risk_notes !== undefined) {
    updatedFields.push("risk_notes");
  }

  // 4. Preserve and patch metadata.platform_native_draft.
  //    The envelope's snake_case shape is what `_generate-draft-action`
  //    persists today (also what generateAndPersistOneDraft writes).
  //    We spread to keep every existing field, then overlay only the
  //    fields the caller is updating.
  const oldMetadata =
    ((existing as { metadata: Record<string, unknown> | null }).metadata ??
      {}) as Record<string, unknown>;
  const oldEnvelope =
    ((oldMetadata.platform_native_draft as Record<string, unknown>) ??
      {}) as Record<string, unknown>;
  const oldCreativeDirection =
    ((oldEnvelope.creative_direction as Record<string, unknown>) ??
      {}) as Record<string, unknown>;

  const newEnvelope: Record<string, unknown> = { ...oldEnvelope };
  let envelopeChanged = false;
  if (args.title !== undefined) {
    newEnvelope.title = args.title;
    envelopeChanged = true;
  }
  if (args.body !== undefined) {
    newEnvelope.body = args.body;
    newEnvelope.hook = extractHook(args.body);
    envelopeChanged = true;
  }
  if (args.cta !== undefined) {
    newEnvelope.cta = args.cta;
    envelopeChanged = true;
  }
  if (creativeBriefValue !== undefined || args.risk_notes !== undefined) {
    const newCreativeDirection: Record<string, unknown> = {
      ...oldCreativeDirection,
    };
    if (creativeBriefValue !== undefined) {
      newCreativeDirection.media_prompt_or_brief = creativeBriefValue;
    }
    if (args.risk_notes !== undefined) {
      newCreativeDirection.media_risk_notes = args.risk_notes;
    }
    newEnvelope.creative_direction = newCreativeDirection;
    envelopeChanged = true;
  }

  const newMetadata: Record<string, unknown> = {
    ...oldMetadata,
    source: "mcp_operation",
    updated_by_operator_token_id: ctx.operatorTokenId,
    mcp_updated_at: new Date().toISOString(),
  };
  // Always write the envelope back (even if unchanged) so the
  // persisted row always carries the canonical envelope shape.
  // Only the platform_native_draft sub-object is updated; other
  // metadata keys are preserved by the spread above.
  if (envelopeChanged || oldEnvelope) {
    newMetadata.platform_native_draft = newEnvelope;
  }
  columnPatch.metadata = newMetadata;

  // 5. Apply the update. Workspace scoping enforced again at the
  //    write boundary (defense in depth — the SELECT already
  //    verified workspace).
  const { data: updated, error } = await ctx.db
    .from("weekly_plan_items")
    .update(columnPatch as never)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.plan_item_id)
    .select("id, status, title, body")
    .single();
  if (error || !updated) {
    return failed({
      tool: TOOL,
      summary: error?.message ?? "update_failed",
    });
  }

  // 6. Activity event.
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.plan_item_updated",
      entity_type: "weekly_plan_item",
      entity_id: args.plan_item_id,
      title: `MCP updated draft item (${updatedFields.join(", ")})`,
      description: null,
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        plan_item_id: args.plan_item_id,
        updated_fields: updatedFields,
        previous_status: status,
      },
    } as never,
  );

  // 7. Compose response. No DID, no token, no metadata exposing
  //    workspace secrets. body_length helps the caller (Claude) verify
  //    the write happened without us echoing the full body back into
  //    the conversation transcript.
  const finalBody = (updated as { body: string | null }).body ?? "";
  return ok({
    tool: TOOL,
    summary: `Updated ${updatedFields.length} field(s) on draft plan item. Operator review still required.`,
    data: {
      plan_item_id: args.plan_item_id,
      status: (updated as { status: string }).status,
      updated_fields: updatedFields,
      body_length: finalBody.length,
      platform_native_draft_updated: envelopeChanged,
      review_url: `/weekly-plan?focus=${encodeURIComponent(args.plan_item_id)}`,
    },
    requiresUserApproval: true,
  });
}
