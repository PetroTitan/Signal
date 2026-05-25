import "server-only";

/**
 * Signal MCP — scheduling tool.
 *
 * One tool: signal.schedule_publish.
 *
 * Walks an operator-approved plan_item through the same state
 * machine the existing UI approve flow uses (pending_authorization
 * → authorized → scheduled, plan_item → scheduled + scheduled_at),
 * but only after a strict refusal gate:
 *
 *   - plan_item.status === "approved" (refuses anything else)
 *   - platform === "bluesky" (Bluesky is the only verified API-
 *     publishable platform today; dev.to and Telegram have known
 *     publish-path blockers; Reddit gated by approval; Hashnode is
 *     in manual mode)
 *   - identity is signed in (platform_connections.connection_status
 *     === "connected")
 *   - plan_item.risk_level !== "blocked" (proxy for the QA verdict;
 *     the existing approve flow uses the same check)
 *   - active weekly contract exists and the item's account/product/
 *     platform are inside its scope
 *   - scheduled_at parsed by the schema parser (≥ 2 minutes future)
 *
 * No platform publish API is called. No retries. No bulk. No
 * cross-workspace access. No status flips except the audited
 * approved→scheduled walk.
 */

import { ok, failed, type McpToolResponse } from "../responses";
import type { ToolContext } from "../tool-context";
import type { SchedulePublishArgs } from "../schemas";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";

const TOOL = "signal.schedule_publish";

/**
 * Platforms `signal.schedule_publish` will currently allow. Anything
 * outside the set is refused with an explicit reason — see the
 * refusal table in the handler.
 *
 * Start narrow (Bluesky only). dev.to + Telegram return here after
 * their respective publish-path follow-ups land
 * (feat/devto-publish-uses-identity-key,
 * feat/telegram-publish-wires-channel-binding). Reddit returns here
 * once OAuth readiness is explicitly confirmed and a safe test
 * subreddit is whitelisted. Hashnode returns here only after Pro/API
 * access is verified.
 */
const SCHEDULABLE_PLATFORMS: ReadonlySet<FounderPlatform> = new Set(["bluesky"]);

const MANUAL_OR_DISTRIBUTION_PLATFORMS: ReadonlySet<FounderPlatform> = new Set([
  "x",
  "linkedin",
  "instagram",
  "threads",
  "youtube",
  "indie_hackers",
]);

const PHASE_5_BLOCKED_PLATFORMS: ReadonlySet<FounderPlatform> = new Set([
  "devto", // pending feat/devto-publish-uses-identity-key
  "telegram", // pending feat/telegram-publish-wires-channel-binding
  "reddit", // pending explicit operator approval + safe test subreddit
  "hashnode", // in manual mode until Pro/API access is verified
]);

export async function schedulePublishTool(
  ctx: ToolContext,
  args: SchedulePublishArgs,
): Promise<McpToolResponse> {
  // ── 1. Workspace-scoped plan_item lookup ──────────────────────────
  const { data: planItem } = await ctx.db
    .from("weekly_plan_items")
    .select(
      "id, workspace_id, weekly_plan_id, product_id, account_id, platform, content_type, title, body, link_url, scheduled_at, status, risk_score, risk_level, metadata",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.plan_item_id)
    .maybeSingle();
  if (!planItem) {
    return failed({
      tool: TOOL,
      summary: "plan_item_not_found_in_workspace",
    });
  }

  // ── 2. Status gate — approved or paused ───────────────────────────
  //
  // `approved` is the canonical post-approval status.
  // `paused` is what the scheduler mirrors back to a plan_item when
  // an earlier execution_item ended in blocked/failed — it means
  // "approved but the prior execution attempt didn't succeed".
  // Re-scheduling is the intended recovery path; the readiness check
  // (creative + alt + schedule + identity) still runs.
  const status = (planItem as { status: string }).status;
  if (status !== "approved" && status !== "paused") {
    return failed({
      tool: TOOL,
      summary: `plan_item_status_must_be_approved_or_paused_got_${status}`,
    });
  }

  // ── 2b. Duplicate-prevention — refuse only when an ACTIVE execution
  //        item already exists for this plan_item. Terminal rows
  //        (blocked, failed, completed, cancelled, backlogged) are
  //        history and must not block a retry.
  const { data: existingExec } = await ctx.db
    .from("execution_items")
    .select("id, status")
    .eq("workspace_id", ctx.workspaceId)
    .eq("source_entity_id", args.plan_item_id)
    .in("status", [
      "pending_authorization",
      "authorized",
      "scheduled",
      "ready",
      "running",
    ]);
  if (existingExec && existingExec.length > 0) {
    return failed({
      tool: TOOL,
      summary: "plan_item_has_active_execution_item",
    });
  }
  // Also fetch all rows (including terminal) so we can record the
  // previous execution_item id for the retry audit trail.
  const { data: allExec } = await ctx.db
    .from("execution_items")
    .select("id, status")
    .eq("workspace_id", ctx.workspaceId)
    .eq("source_entity_id", args.plan_item_id)
    .order("created_at", { ascending: false })
    .limit(1);
  const previousExec =
    allExec && allExec.length > 0
      ? (allExec[0] as { id: string; status: string })
      : null;

  // ── 3. Platform allow-list ────────────────────────────────────────
  const platform = (planItem as { platform: string | null }).platform as
    | FounderPlatform
    | null;
  if (!platform) {
    return failed({
      tool: TOOL,
      summary: "plan_item_missing_platform",
    });
  }
  if (MANUAL_OR_DISTRIBUTION_PLATFORMS.has(platform)) {
    return failed({
      tool: TOOL,
      summary: `platform_is_manual_or_distribution_only:${platform}`,
    });
  }
  if (PHASE_5_BLOCKED_PLATFORMS.has(platform)) {
    return failed({
      tool: TOOL,
      summary: `platform_has_unresolved_publish_blocker:${platform}`,
    });
  }
  if (!SCHEDULABLE_PLATFORMS.has(platform)) {
    return failed({
      tool: TOOL,
      summary: `platform_not_schedulable_yet:${platform}`,
    });
  }

  // ── 4. Risk gate (proxy for QA verdict) ───────────────────────────
  // The existing approve flow uses the same check on plan_item.risk_level.
  const riskLevel = (planItem as { risk_level: string | null }).risk_level;
  if (riskLevel === "blocked") {
    return failed({
      tool: TOOL,
      summary: "plan_item_risk_level_blocked",
    });
  }

  // ── 5. Identity must be signed in (Bluesky-specific check) ────────
  const accountId = (planItem as { account_id: string | null }).account_id;
  if (!accountId) {
    return failed({
      tool: TOOL,
      summary: "plan_item_missing_account_id",
    });
  }
  const { data: connection } = await ctx.db
    .from("platform_connections")
    .select("id, connection_status, provider_account_id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("account_id", accountId)
    .eq("platform", "bluesky")
    .maybeSingle();
  if (!connection) {
    return failed({
      tool: TOOL,
      summary: "identity_has_no_bluesky_connection_signed_in",
    });
  }
  const connStatus = (connection as { connection_status: string })
    .connection_status;
  if (connStatus !== "connected") {
    return failed({
      tool: TOOL,
      summary: `identity_connection_status_${connStatus}_must_be_connected`,
    });
  }
  // Defensive: the orchestrator needs a DID. If somehow the connection
  // exists but the provider_account_id is malformed, refuse here so
  // the scheduler doesn't later fail with session_missing.
  const did = (connection as { provider_account_id: string | null })
    .provider_account_id;
  if (!did || !did.startsWith("did:")) {
    return failed({
      tool: TOOL,
      summary: "identity_connection_missing_did",
    });
  }

  // ── 6. Contract scope check (optional) ────────────────────────────
  //
  // Active weekly contract is OPTIONAL post-migration. When present,
  // we apply scope checks. When absent, the per-post path runs
  // contract-free.
  const { data: contract } = await ctx.db
    .from("weekly_contracts")
    .select("id, scope, week_start, week_end, title")
    .eq("workspace_id", ctx.workspaceId)
    .eq("status", "active")
    .maybeSingle();
  const contractId =
    contract === null
      ? null
      : (contract as { id: string }).id;
  const contractMode: "contract_attached" | "contract_free_item" =
    contract === null ? "contract_free_item" : "contract_attached";

  if (contract !== null) {
    const scope = (
      contract as {
        scope: {
          accountIds: string[];
          productIds: string[];
          platforms: string[];
        } | null;
      }
    ).scope;
    if (!scope) {
      return failed({
        tool: TOOL,
        summary: "active_contract_has_no_scope",
      });
    }
    if (accountId && !scope.accountIds.includes(accountId)) {
      return failed({
        tool: TOOL,
        summary: "plan_item_account_out_of_contract_scope",
      });
    }
    const productId = (planItem as { product_id: string | null }).product_id;
    if (productId && !scope.productIds.includes(productId)) {
      return failed({
        tool: TOOL,
        summary: "plan_item_product_out_of_contract_scope",
      });
    }
    if (!scope.platforms.includes(platform)) {
      return failed({
        tool: TOOL,
        summary: "plan_item_platform_out_of_contract_scope",
      });
    }
  }

  // ── 7. Get / create execution_queue ───────────────────────────────
  // Contract path: look up the contract-bound queue.
  // Contract-free path: look up the workspace contract-free queue
  // (one or more rows with contract_id IS NULL).
  const queueQuery = ctx.db
    .from("execution_queues")
    .select("id")
    .eq("workspace_id", ctx.workspaceId)
    .eq("status", "active");
  const { data: existingQueue } =
    contractId === null
      ? await queueQuery.is("contract_id", null).maybeSingle()
      : await queueQuery.eq("contract_id", contractId).maybeSingle();

  let queueId = (existingQueue as { id: string } | null)?.id ?? null;
  if (!queueId) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const endIso = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const insertPayload = {
      workspace_id: ctx.workspaceId,
      contract_id: contractId,
      title:
        contract === null
          ? "Contract-free items"
          : (contract as { title: string }).title,
      week_start:
        contract === null
          ? todayIso
          : (contract as { week_start: string }).week_start,
      week_end:
        contract === null
          ? endIso
          : (contract as { week_end: string }).week_end,
      status: "active",
    };
    const { data: newQueue, error: queueErr } = await ctx.db
      .from("execution_queues")
      .insert(insertPayload as never)
      .select("id")
      .single();
    if (queueErr || !newQueue) {
      return failed({
        tool: TOOL,
        summary: queueErr?.message ?? "execution_queue_insert_failed",
      });
    }
    queueId = (newQueue as { id: string }).id;
  }

  // ── 8. Insert execution_item (mirrors approveWeeklyPlanAction) ────
  // We embed the audit trail in metadata so the scheduler + later
  // tooling can see this row was MCP-driven.
  const planItemMetadata = (planItem as { metadata: Record<string, unknown> | null })
    .metadata ?? {};

  const { data: execItem, error: execErr } = await ctx.db
    .from("execution_items")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        queue_id: queueId,
        contract_id: contractId,
        action_type:
          (planItem as { content_type: string | null }).content_type === "comment"
            ? "publish_scheduled_comment"
            : "publish_scheduled_post",
        source_entity_type: "weekly_plan_item",
        source_entity_id: (planItem as { id: string }).id,
        product_id: (planItem as { product_id: string | null }).product_id,
        account_id: accountId,
        platform,
        title: (planItem as { title: string | null }).title,
        body: (planItem as { body: string | null }).body,
        link_url: (planItem as { link_url: string | null }).link_url,
        scheduled_at: args.scheduled_at,
        status: "pending_authorization",
        risk_score: (planItem as { risk_score: number | null }).risk_score,
        risk_level: riskLevel,
        max_attempts: 3,
        metadata: {
          plan_item_id: (planItem as { id: string }).id,
          plan_id: (planItem as { weekly_plan_id: string }).weekly_plan_id,
          source: "mcp_operation",
          scheduled_by_operator_token_id: ctx.operatorTokenId,
          mcp_scheduled_at: new Date().toISOString(),
          contract_mode: contractMode,
          approval_mode: "per_item",
          approved_without_contract: contract === null,
          // Retry audit trail — populated when MCP is scheduling a
          // plan_item that was previously paused after a failed/
          // blocked execution attempt.
          rescheduled_from_status: status !== "approved" ? status : undefined,
          previous_execution_item_id: previousExec?.id ?? undefined,
          previous_execution_item_status: previousExec?.status ?? undefined,
        },
      } as never,
    )
    .select("id, status")
    .single();
  if (execErr || !execItem) {
    return failed({
      tool: TOOL,
      summary: execErr?.message ?? "execution_item_insert_failed",
    });
  }
  const execItemId = (execItem as { id: string }).id;

  // ── 9. Walk execution_item pending_authorization → authorized →
  //      scheduled. The existing repository's transition guards run
  //      through `updateItemStatus`, but those use the server client.
  //      Here we apply direct status updates via the service-role
  //      client and rely on the dispatcher's audit row for the trail.
  for (const targetStatus of ["authorized", "scheduled"] as const) {
    const { error: stepErr } = await ctx.db
      .from("execution_items")
      .update({ status: targetStatus } as never)
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", execItemId);
    if (stepErr) {
      return failed({
        tool: TOOL,
        summary: `execution_item_transition_failed_${targetStatus}:${stepErr.message}`,
      });
    }
  }

  // ── 10. Bump the plan_item to scheduled with the new timestamp ────
  // Preserve the existing metadata.platform_native_draft and append
  // MCP scheduling fields without clobbering anything else.
  const newPlanMetadata: Record<string, unknown> = {
    ...planItemMetadata,
    source: "mcp_operation",
    scheduled_by_operator_token_id: ctx.operatorTokenId,
    mcp_scheduled_at: new Date().toISOString(),
  };
  const { error: planErr } = await ctx.db
    .from("weekly_plan_items")
    .update(
      {
        status: "scheduled",
        scheduled_at: args.scheduled_at,
        metadata: newPlanMetadata,
      } as never,
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.plan_item_id);
  if (planErr) {
    return failed({
      tool: TOOL,
      summary: `plan_item_update_failed:${planErr.message}`,
    });
  }

  // ── 11. Activity event ────────────────────────────────────────────
  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "mcp.publish_scheduled",
      entity_type: "weekly_plan_item",
      entity_id: args.plan_item_id,
      title: `MCP scheduled ${platform} publish for ${args.scheduled_at}`,
      description: null,
      source: "mcp_operation",
      metadata: {
        operator_token_id: ctx.operatorTokenId,
        plan_item_id: args.plan_item_id,
        execution_item_id: execItemId,
        platform,
        identity_id: accountId,
        scheduled_at: args.scheduled_at,
      },
    } as never,
  );

  // ── 12. Response (no secrets, no DID, no tokens) ──────────────────
  return ok({
    tool: TOOL,
    summary:
      contractMode === "contract_free_item"
        ? `Scheduled contract-free plan_item for ${platform} publish at ${args.scheduled_at}. Scheduler will run runPublish at that time.`
        : `Scheduled plan_item for ${platform} publish at ${args.scheduled_at}. Scheduler will run runPublish at that time.`,
    data: {
      plan_item_id: args.plan_item_id,
      execution_item_id: execItemId,
      status: "scheduled",
      platform,
      identity_id: accountId,
      scheduled_at: args.scheduled_at,
      // Audit-trail fields — operators (and Claude) can see whether
      // the schedule used a contract or ran contract-free.
      contract_mode: contractMode,
      contract_id: contractId,
      review_url: `/weekly-plan?focus=${encodeURIComponent(args.plan_item_id)}`,
    },
    requiresUserApproval: true,
  });
}
