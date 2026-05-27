import "server-only";
import { ok, failed, type McpToolResponse } from "../responses";
import type { ToolContext } from "../tool-context";
import type {
  AccountsPrepareArgs,
  ImportsPrepareMappingArgs,
  ProductsPrepareArgs,
  ReportsSubmitArgs,
  UploadCreativeAssetArgs,
  WeeklyPlanAttachCreativeArgs,
  WeeklyPlanPrepareItemArgs,
} from "../schemas";
import {
  buildShapeForCreate,
  serializeMcpResponse,
} from "../platform-intent";
import type { PublishPlatform } from "@/core/publishing/publishing-types";
import {
  validateIdentityReferenceUrls,
  validateIdentitySourceUrl,
} from "@/core/identity-sources/url-validation";
import { requiresCreative } from "@/core/platform-native/approval-policy";
import { validateAttachInput } from "@/core/publishing/creative-readiness";

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
  "id, platform, handle, display_name, voice_profile, product_id, status, connection_status, source, review_status, source_website_url, reference_urls, created_at";

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

  // Phase F7.0 — validate optional source URLs upfront. Failure
  // here is a 4xx-shaped validation refusal: no DB write, structured
  // error code surfaced to the caller.
  let normalizedSourceWebsiteUrl: string | null | undefined;
  if (args.source_website_url !== undefined) {
    if (args.source_website_url === null) {
      normalizedSourceWebsiteUrl = null;
    } else {
      const r = validateIdentitySourceUrl(args.source_website_url);
      if (!r.ok) {
        return failed({
          tool: "signal.accounts.prepare",
          summary: `source_website_url_invalid:${r.error}`,
          warnings: r.message ? [r.message] : [],
        });
      }
      normalizedSourceWebsiteUrl = r.normalized;
    }
  }
  let normalizedReferenceUrls: string[] | null | undefined;
  if (args.reference_urls !== undefined) {
    if (args.reference_urls === null) {
      normalizedReferenceUrls = null;
    } else {
      const r = validateIdentityReferenceUrls(args.reference_urls);
      if (!r.ok) {
        return failed({
          tool: "signal.accounts.prepare",
          summary: `reference_urls_invalid:${r.errors
            .map((e) => `${e.index}:${e.error}`)
            .join(",")}`,
          warnings: r.errors.map((e) => `[${e.index}] ${e.message}`),
        });
      }
      normalizedReferenceUrls = r.normalized;
    }
  }

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
    // Only patch fields the caller explicitly provided. The parser
    // preserves `undefined` for absent fields, so this preserves
    // existing voice_profile / review_status / product_id values when
    // the caller didn't mean to change them.
    const patch: Record<string, unknown> = {
      display_name: args.display_name,
    };
    if (args.voice_profile !== undefined) patch.voice_profile = args.voice_profile;
    if (args.product_id !== undefined) patch.product_id = args.product_id;
    if (args.review_status !== undefined) patch.review_status = args.review_status;
    if (normalizedSourceWebsiteUrl !== undefined) {
      patch.source_website_url = normalizedSourceWebsiteUrl;
    }
    if (normalizedReferenceUrls !== undefined) {
      patch.reference_urls = normalizedReferenceUrls ?? [];
    }
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
    const effectiveReview =
      (updated as { review_status?: string }).review_status ??
      (existing as { review_status?: string }).review_status ??
      "pending_review";
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
        effectiveReview === "confirmed"
          ? "Updated existing growth account (confirmed)."
          : "Updated existing growth account (pending_review).",
      data: { account: updated, idempotent: true },
      requiresUserApproval: effectiveReview !== "confirmed",
    });
  }

  // Insert path — only here do we default review_status, since this is
  // a brand-new row with no prior state to preserve.
  const reviewStatus = args.review_status ?? "pending_review";
  const { data, error } = await ctx.db
    .from("growth_accounts")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        product_id: args.product_id ?? null,
        platform: args.platform,
        handle: args.handle ?? null,
        display_name: args.display_name,
        role: null,
        voice_profile: args.voice_profile ?? null,
        status: "planned",
        connection_status: "not_connected",
        source: "mcp_operation",
        review_status: reviewStatus,
        source_website_url: normalizedSourceWebsiteUrl ?? null,
        reference_urls: normalizedReferenceUrls ?? [],
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

  // Default is `pending_approval` so MCP-created items appear in the
  // approval panel on /weekly-plan. Callers that want a private holding
  // pen can pass `save_as_draft: true`.
  const targetStatus = args.save_as_draft ? "draft" : "pending_approval";
  const itemMetadata: Record<string, unknown> = {
    source: "mcp_operation",
    operator_token_id: ctx.operatorTokenId,
  };
  if (args.timezone) itemMetadata.timezone = args.timezone;

  // Phase F6.1 — optional platform-native intent. Construct the shape
  // BEFORE the insert so capability-validation failures abort early
  // (no orphan row written).
  const intentResult = buildShapeForCreate({
    platform: (args.platform as PublishPlatform | null) ?? null,
    input: args.platform_intent ?? {},
  });
  if (intentResult.blockers.length > 0) {
    return failed({
      tool: "signal.weekly_plan.prepare_item",
      summary: `platform_intent_invalid:${intentResult.blockers
        .map((b) => b.code)
        .join(",")}`,
      warnings: intentResult.blockers.map(
        (b) => `${b.code}: ${b.message}`,
      ),
    });
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
        status: targetStatus,
        metadata: itemMetadata,
        platform_publish_intent: intentResult.serialized,
      } as never,
    )
    .select(
      "id, weekly_plan_id, platform, content_type, title, status, risk_score, scheduled_at, created_at, platform_publish_intent",
    )
    .single();
  if (error || !data)
    return failed({
      tool: "signal.weekly_plan.prepare_item",
      summary: error?.message ?? "item_insert_failed",
    });

  // Whether to drop a planned-creative placeholder when the operator
  // didn't pass `creative_required` explicitly.
  //
  // Default now consults the central platform-native approval policy
  // — same source of truth as `assessItemApprovalReadiness` and the
  // /weekly-plan UI warning banner. Platforms / intents where a
  // creative is OPTIONAL (Telegram channel messages, Bluesky text
  // posts, dev.to / Hashnode articles, etc.) skip the auto-attach
  // entirely instead of dropping a misleading `planned` placeholder
  // that the operator then has to clear.
  //
  // Required-creative cases (Instagram + any intent, YouTube +
  // video_post, intent ∈ {media_post, carousel, story, short_video}
  // on any platform) still get the placeholder so the approval
  // queue surfaces "creative missing" UX as before.
  //
  // Explicit `args.creative_required === true | false` still
  // overrides the policy default unchanged.
  const itemId = (data as { id: string }).id;
  const creativeRequired =
    args.creative_required ??
    requiresCreative({
      platform: (args.platform as string | null) ?? null,
      intent: intentResult.shape?.intent ?? null,
    });
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
        ? "Created weekly_plan_item as pending_approval (visible in the /weekly-plan approval panel)."
        : "Created weekly_plan_item as draft (not yet visible in the approval panel).",
    data: {
      item: data,
      creative: creativeRow,
      ...serializeMcpResponse(intentResult),
    },
    warnings: [...intentResult.warnings],
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

  // Hard refusal for the false-ready state: source_type='generated'
  // with no real asset reference (asset_url AND source_url both
  // null/empty) is a prompt-only creative pretending to be media.
  // The operator should attach it as `source_type='planned'`
  // instead and upgrade once an asset actually exists. The schema
  // parser already requires `prompt` for generated; this layer
  // adds the asset-presence requirement.
  const attachRefusal = validateAttachInput({
    sourceType: args.source_type,
    assetUrl: args.asset_url ?? null,
    sourceUrl: args.source_url ?? null,
    prompt: args.prompt ?? null,
  });
  if (attachRefusal !== null) {
    return failed({
      tool: "signal.weekly_plan.attach_creative",
      summary:
        attachRefusal === "generated_requires_asset_use_planned"
          ? "Prompt-only creatives must be attached as source_type='planned' (no asset_url + no source_url present). Generated source_type requires a real asset reference."
          : attachRefusal === "generated_requires_prompt"
            ? "Generated creatives require a prompt."
            : "External-source creatives require a source_url.",
    });
  }

  // Status mapping is derived from source_type:
  //   - "planned"  → status='planned'  (placeholder; no asset)
  //   - others     → status='pending_review' once the asset is
  //                  attached. The attach guard above ensures a
  //                  real asset reference exists before reaching
  //                  this line for any non-planned source.
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

// =====================================================================
// signal.upload_creative_asset
//
// Ingests an already-generated media file (binary as base64) into
// the existing `weekly-plan-creatives` Supabase Storage bucket and
// attaches it to a weekly_plan_item.
//
// Reuses the operator-driven server-action path's conventions
// verbatim (`validateUpload`, bucket name, `<workspaceId>/<itemId>/
// <uuid>.<ext>` path, `creativeTypeForMime`) — the only difference
// is the row's `status` lands as `pending_review` (NOT `approved`).
// MCP-ingested means a non-operator (Codex/Claude/external tool)
// supplied the file; operator review is still required.
//
// Hard boundaries:
//   - source_type is always "uploaded". Refused at the schema parser
//     if the caller tries to write "generated" through this path
//     (Signal does not generate; that label is reserved for an
//     in-house generator that doesn't exist yet).
//   - No execution_items, no scheduling, no publishing, no provider
//     adapters touched.
//   - The bot token / Supabase service role keys are never logged.
//     The base64 payload is decoded once into a Buffer that lives
//     only for the duration of this function.
// =====================================================================

export async function uploadCreativeAsset(
  ctx: ToolContext,
  args: UploadCreativeAssetArgs,
): Promise<McpToolResponse> {
  // 1) Verify the item belongs to this workspace.
  const { data: itemCheck } = await ctx.db
    .from("weekly_plan_items")
    .select("id, content_type")
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.weekly_plan_item_id)
    .maybeSingle();
  if (!itemCheck) {
    return failed({
      tool: "signal.upload_creative_asset",
      summary: "weekly_plan_item not found in this workspace",
    });
  }

  // 2) MIME + size validation — REUSES the same helper the
  //    operator-driven upload action uses, so the constraint
  //    surface is shared.
  const { validateUpload, extensionForMime, creativeTypeForMime } =
    await import("@/core/publishing/creative-upload-policy");

  // Decode the base64 payload once. Defensive: refuse if the
  // decode fails or the resulting buffer is empty. The buffer is
  // only alive in this stack frame.
  let buf: Buffer;
  try {
    buf = Buffer.from(args.file_base64, "base64");
  } catch {
    return failed({
      tool: "signal.upload_creative_asset",
      summary: "file_base64_decode_failed",
    });
  }
  if (buf.length === 0) {
    return failed({
      tool: "signal.upload_creative_asset",
      summary: "file_base64_empty",
    });
  }

  const validation = validateUpload({
    mime: args.mime_type,
    sizeBytes: buf.length,
  });
  if (!validation.ok) {
    return failed({
      tool: "signal.upload_creative_asset",
      summary: validation.reason ?? "upload_validation_failed",
    });
  }
  const mime = args.mime_type as import(
    "@/core/publishing/creative-upload-policy"
  ).AllowedMime;
  const creativeType =
    args.creative_type ?? creativeTypeForMime(mime);

  // 3) Upload to the existing `weekly-plan-creatives` bucket using
  //    the existing `<workspaceId>/<itemId>/<uuid>.<ext>` path
  //    convention.
  const { randomUUID } = await import("node:crypto");
  const ext = extensionForMime(mime);
  const objectName = `${ctx.workspaceId}/${args.weekly_plan_item_id}/${randomUUID()}.${ext}`;

  const upload = await ctx.db.storage
    .from("weekly-plan-creatives")
    .upload(objectName, buf, {
      contentType: mime,
      cacheControl: "3600",
      upsert: false,
    });
  if (upload.error) {
    return failed({
      tool: "signal.upload_creative_asset",
      summary: `storage_upload_failed:${upload.error.message}`,
    });
  }

  const { data: pub } = ctx.db.storage
    .from("weekly-plan-creatives")
    .getPublicUrl(objectName);
  const assetUrl = pub.publicUrl;

  // 4) Persist the creative row as `pending_review` — NOT
  //    `approved`. The operator-driven server action auto-approves
  //    (the operator IS the uploader); the MCP path must NOT
  //    bypass review.
  //
  //    We write via a direct insert (mirrors the
  //    weeklyPlanAttachCreative shape) instead of going through the
  //    server-action repository to keep the MCP code path
  //    self-contained.
  const origin = args.origin ?? "ai_external";
  const metadata: Record<string, unknown> = {
    source: "mcp_operation",
    operator_token_id: ctx.operatorTokenId,
    origin,
    storage_path: objectName,
    mime_type: mime,
    size_bytes: buf.length,
    uploaded_at: new Date().toISOString(),
  };
  if (args.aspect_ratio) metadata.aspect_ratio = args.aspect_ratio;
  if (args.notes) metadata.notes = args.notes;

  const { data: row, error: insertError } = await ctx.db
    .from("weekly_plan_item_creatives")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        weekly_plan_item_id: args.weekly_plan_item_id,
        creative_type: creativeType,
        source_type: "uploaded",
        asset_url: assetUrl,
        storage_path: objectName,
        mime_type: mime,
        size_bytes: buf.length,
        prompt: args.prompt,
        alt_text: args.alt_text,
        status: "pending_review",
        metadata,
      } as never,
    )
    .select(
      "id, weekly_plan_item_id, creative_type, source_type, status, asset_url, storage_path, alt_text, mime_type, size_bytes",
    )
    .single();
  if (insertError || !row) {
    // Best-effort cleanup of the storage object so we don't leave
    // orphan files when the DB write fails.
    await ctx.db.storage
      .from("weekly-plan-creatives")
      .remove([objectName])
      .catch(() => undefined);
    return failed({
      tool: "signal.upload_creative_asset",
      summary: insertError?.message ?? "creative_insert_failed",
    });
  }

  // 5) Activity event for the audit trail. Never includes the
  //    file content; only the storage path + size.
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.weekly_plan_item_creative_asset_uploaded",
      entity_type: "weekly_plan_item_creative",
      entity_id: (row as { id: string }).id,
      title: `MCP uploaded creative asset (${creativeType} · ${mime})`,
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        weekly_plan_item_id: args.weekly_plan_item_id,
        storage_path: objectName,
        size_bytes: buf.length,
        origin,
      },
    } as never,
  );

  // 6) Surface the derived readiness state so the caller can
  //    confirm the transition (planned/not-ready → pending_review)
  //    without an extra read.
  const { deriveCreativeReadinessState } = await import(
    "@/core/publishing/creative-readiness"
  );
  const readinessState = deriveCreativeReadinessState({
    status: "pending_review",
    sourceType: "uploaded",
    assetUrl,
    sourceUrl: null,
    storagePath: objectName,
    altText: args.alt_text ?? null,
    prompt: args.prompt ?? null,
    license: null,
    attribution: null,
  });

  return ok({
    tool: "signal.upload_creative_asset",
    summary: `Uploaded creative as pending_review (${creativeType} · ${mime}, ${buf.length} bytes).`,
    data: {
      creative: row,
      storage_path: objectName,
      asset_url: assetUrl,
      readiness_state: readinessState,
      asset_present: true,
      ready_for_publish: false,
    },
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
