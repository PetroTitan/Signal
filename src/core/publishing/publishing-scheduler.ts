import "server-only";
/**
 * Phase F1 — lightweight scheduler.
 *
 * No persistent worker, no Kubernetes, no job queue. The scheduler
 * is a single `tickOnce` function:
 *
 *   1. Find execution_items in 'scheduled' state with
 *      scheduled_at <= now.
 *   2. For each item, load its companion plan_item / contract /
 *      account / connection.
 *   3. Build a `PublishRequest` + `PolicyContext`.
 *   4. Call `runPublish`.
 *   5. Update execution_items + weekly_plan_items based on the
 *      outcome, append execution_logs.
 *
 * Invoked from `/api/scheduler/tick` (gated by SCHEDULER_TICK_TOKEN)
 * or from a manual operator-side trigger. Each call is bounded
 * (default 10 items per tick) so a failing tick can't lock the
 * runtime.
 */

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";
import { runPublish } from "./publishing-runner";
import type {
  PublishMode,
  PublishOutcome,
  PublishPlatform,
} from "./publishing-types";

/**
 * Map a publish outcome to the next `execution_items.status`.
 *
 * Two classes of skip:
 *
 *   - TRANSIENT (e.g. `scheduled_in_future`): the gate is time-based
 *     and will clear on its own. Leave the row in `"scheduled"` so
 *     the next tick re-fetches it.
 *
 *   - STRUCTURAL (e.g. `execution_mode_dry_run`): the gate is a
 *     workspace configuration the operator must change. Transition
 *     the row to `"blocked"` so the UI surfaces the situation and
 *     the operator can act. Leaving these stuck on `"scheduled"`
 *     forever is the silent-skip failure mode the user reported.
 *
 * Pure. No I/O. Exported so the scheduler test can pin behavior
 * exhaustively.
 */
export function nextExecutionStatusForOutcome(
  outcome: PublishOutcome,
): "completed" | "scheduled" | "blocked" | "failed" {
  if (outcome.status === "published") return "completed";
  if (outcome.status === "blocked") return "blocked";
  if (outcome.status === "failed") return "failed";
  if (outcome.status === "skipped") {
    if (outcome.reasonCode === "scheduled_in_future") return "scheduled";
    return "blocked";
  }
  // outcome.status === "not_implemented" or any future addition →
  // treat as failed so the row exits "scheduled".
  return "failed";
}

/**
 * Platforms the scheduler tick can fully drive end-to-end (auth +
 * publish + history write).
 *
 * Other platforms (devto / hashnode / telegram / youtube / threads /
 * instagram) are published via the manual confirmation path on
 * `/execution/items/[id]` — the scheduler skips them silently to
 * avoid surprises.
 *
 * Bluesky was missing from this list pre-fix, which caused approved
 * + scheduled Bluesky items to be selected every tick but skipped
 * with `platform_not_supported` and never published. The runner
 * itself (`runPublish` → `publishBlueskyForIdentity`) was fine —
 * the scheduler just never routed Bluesky items to it.
 */
export const SCHEDULER_AUTONOMOUS_PLATFORMS: ReadonlySet<PublishPlatform> =
  new Set(["reddit", "x", "linkedin", "bluesky"]);

export interface SchedulerTickInput {
  /** Soft cap on items processed per tick. Default 10. */
  maxItems?: number;
  /** Override `now` for testing. Defaults to current time. */
  nowIso?: string;
}

export interface SchedulerTickResult {
  attempted: number;
  published: number;
  skipped: number;
  blocked: number;
  failed: number;
  not_implemented: number;
  results: Array<{
    execution_item_id: string;
    workspace_id: string;
    platform: PublishPlatform;
    outcome: PublishOutcome;
  }>;
}

/**
 * Run one batch. Returns a structured summary; never throws.
 */
export async function tickOnce(
  input: SchedulerTickInput = {},
): Promise<SchedulerTickResult> {
  const supabase = createSupabaseServiceRoleClient();
  const empty: SchedulerTickResult = {
    attempted: 0,
    published: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
    not_implemented: 0,
    results: [],
  };
  if (!supabase) {
    return empty;
  }
  const nowIso = input.nowIso ?? new Date().toISOString();
  const maxItems = Math.max(1, Math.min(50, input.maxItems ?? 10));

  // 1) Eligible items: scheduled + scheduled_at <= now.
  const { data: items } = await supabase
    .from("execution_items")
    .select(
      "id, workspace_id, queue_id, contract_id, account_id, product_id, platform, action_type, title, body, link_url, scheduled_at, status, risk_level, attempt_count, max_attempts, metadata",
    )
    .eq("status", "scheduled")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(maxItems);

  if (!items || items.length === 0) return empty;

  const results: SchedulerTickResult["results"] = [];
  for (const raw of items as Array<{
    id: string;
    workspace_id: string;
    queue_id: string;
    contract_id: string | null;
    account_id: string | null;
    product_id: string | null;
    platform: string | null;
    title: string | null;
    body: string | null;
    link_url: string | null;
    scheduled_at: string | null;
    risk_level: string | null;
    attempt_count: number;
    max_attempts: number;
    metadata: Record<string, unknown>;
  }>) {
    const platform = (raw.platform ?? "") as PublishPlatform;
    if (!SCHEDULER_AUTONOMOUS_PLATFORMS.has(platform)) {
      // Unsupported platform — skip this item.
      results.push({
        execution_item_id: raw.id,
        workspace_id: raw.workspace_id,
        platform: (raw.platform as PublishPlatform) ?? "reddit",
        outcome: {
          status: "skipped",
          reasonCode: "platform_not_supported",
          reasonDetail: `Item has unsupported platform "${raw.platform ?? "null"}".`,
          externalId: null,
          externalUrl: null,
          metadata: {},
        },
      });
      continue;
    }

    // Phase F2.5 — under SAFE_TEST_MODE the scheduler is a courier,
    // not a publisher. It only walks eligible reddit posts from
    // 'scheduled' to 'ready'. The operator must visit /execution/[id]
    // and explicitly confirm to actually publish.
    const { safeTestModeEnabled } = await import("./safe-test-env");
    if (safeTestModeEnabled() && platform === "reddit") {
      await markItemReadyForPublish({
        supabase,
        item: raw,
        nowIso,
      });
      results.push({
        execution_item_id: raw.id,
        workspace_id: raw.workspace_id,
        platform,
        outcome: {
          status: "skipped",
          reasonCode: "safe_test_mode_ready_for_publish",
          reasonDetail:
            "Item marked ready_for_publish — operator must confirm at /execution.",
          externalId: null,
          externalUrl: null,
          metadata: {},
        },
      });
      continue;
    }

    // Wrap publishOne in try/catch so a thrown exception cannot
    // leave the item stuck at `scheduled` forever. The user's
    // invariant: "every scheduled item picked by scheduler must
    // result in a status transition." We synthesize a `failed`
    // outcome with reasonCode `scheduler_exception` and let
    // applyOutcome persist it.
    let outcome: PublishOutcome;
    try {
      outcome = await publishOne({
        supabase,
        nowIso,
        item: raw,
        platform,
      });
    } catch (err) {
      outcome = {
        status: "failed",
        reasonCode: "scheduler_exception",
        reasonDetail:
          err instanceof Error
            ? `Scheduler threw before publish completed: ${err.message}`
            : "Scheduler threw before publish completed.",
        externalId: null,
        externalUrl: null,
        metadata: {},
      };
      // Persist via the same outcome path used on the happy path —
      // guarantees execution_items.status moves out of "scheduled",
      // execution_logs gets a row, and plan_item.status mirrors to
      // "paused". No token leakage (reasonDetail comes from
      // err.message; the publisher functions don't put secrets in
      // exception messages).
      await applyOutcome({ supabase, item: raw, outcome });
    }
    results.push({
      execution_item_id: raw.id,
      workspace_id: raw.workspace_id,
      platform,
      outcome,
    });
  }

  const summary: SchedulerTickResult = {
    attempted: results.length,
    published: results.filter((r) => r.outcome.status === "published").length,
    skipped: results.filter((r) => r.outcome.status === "skipped").length,
    blocked: results.filter((r) => r.outcome.status === "blocked").length,
    failed: results.filter((r) => r.outcome.status === "failed").length,
    not_implemented: results.filter((r) => r.outcome.status === "not_implemented")
      .length,
    results,
  };
  return summary;
}

interface PublishOneInput {
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;
  nowIso: string;
  platform: PublishPlatform;
  item: {
    id: string;
    workspace_id: string;
    queue_id: string;
    contract_id: string | null;
    account_id: string | null;
    product_id: string | null;
    title: string | null;
    body: string | null;
    link_url: string | null;
    scheduled_at: string | null;
    risk_level: string | null;
    attempt_count: number;
    max_attempts: number;
    metadata: Record<string, unknown>;
  };
}

async function publishOne(input: PublishOneInput): Promise<PublishOutcome> {
  const { supabase, nowIso, item, platform } = input;

  // Workspace publishing mode (dry_run | live).
  const { data: settings } = await supabase
    .from("workspace_settings")
    .select("*")
    .eq("workspace_id", item.workspace_id)
    .maybeSingle();
  const mode: PublishMode =
    ((settings as { execution_mode?: string } | null)?.execution_mode ===
      "live"
      ? "live"
      : "dry_run");

  // Active contract for this workspace?
  const { data: contractRow } = await supabase
    .from("weekly_approval_contracts")
    .select("id, status")
    .eq("workspace_id", item.workspace_id)
    .eq("status", "active")
    .maybeSingle();
  const hasActiveContract = Boolean(contractRow);

  // Account + product review_status.
  let accountReviewStatus: string | null = null;
  if (item.account_id) {
    const { data: acct } = await supabase
      .from("growth_accounts")
      .select("review_status")
      .eq("id", item.account_id)
      .eq("workspace_id", item.workspace_id)
      .maybeSingle();
    accountReviewStatus =
      ((acct as { review_status?: string } | null)?.review_status) ?? null;
  }
  let productReviewStatus: string | null = null;
  if (item.product_id) {
    const { data: prod } = await supabase
      .from("products")
      .select("review_status")
      .eq("id", item.product_id)
      .eq("workspace_id", item.workspace_id)
      .maybeSingle();
    productReviewStatus =
      ((prod as { review_status?: string } | null)?.review_status) ?? null;
  }

  // Platform connection + stored encrypted token.
  let connectionStatus: string | null = null;
  let accessTokenEncrypted: string | null = null;
  if (item.account_id) {
    const { data: conn } = await supabase
      .from("platform_connections")
      .select("connection_status, access_token_encrypted")
      .eq("workspace_id", item.workspace_id)
      .eq("account_id", item.account_id)
      .eq("platform", platform)
      .maybeSingle();
    if (conn) {
      connectionStatus =
        (conn as { connection_status?: string }).connection_status ?? null;
      accessTokenEncrypted =
        (conn as { access_token_encrypted?: string | null })
          .access_token_encrypted ?? null;
    }
  }

  // Phase F2 — decrypt at the last possible moment, only when:
  //   - we're in live mode AND
  //   - the cipher is available AND
  //   - we actually have an encrypted envelope.
  // The plaintext is held in scope just for this publish attempt.
  // The policy gate still runs after this; if any other gate fails,
  // the plaintext is dropped without being passed to the publisher.
  let accessToken: string | null = null;
  if (mode === "live" && accessTokenEncrypted) {
    const { decryptForOutboundUse } = await import("@/core/platform-oauth");
    accessToken = decryptForOutboundUse(accessTokenEncrypted);
  }

  const target =
    typeof (item.metadata as { target?: string })?.target === "string"
      ? ((item.metadata as { target: string }).target)
      : null;

  const outcome = await runPublish({
    request: {
      workspaceId: item.workspace_id,
      planItemId:
        (item.metadata as { plan_item_id?: string })?.plan_item_id ?? "",
      executionItemId: item.id,
      platform,
      accountId: item.account_id ?? "",
      productId: item.product_id,
      title: item.title,
      body: item.body,
      linkUrl: item.link_url,
      target,
      mode,
    },
    context: {
      hasActiveContract,
      accountReviewStatus,
      productReviewStatus,
      connectionStatus,
      hasStoredAccessToken: accessTokenEncrypted !== null,
      scheduledFor: item.scheduled_at,
      nowIso,
      publishingEnabled: mode === "live",
      riskLevel: item.risk_level,
    },
    accessToken,
    target,
  });

  await applyOutcome({
    supabase,
    item,
    outcome,
  });

  return outcome;
}

interface ApplyOutcomeInput {
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;
  item: { id: string; workspace_id: string; queue_id: string; metadata: Record<string, unknown> };
  outcome: PublishOutcome;
}

async function applyOutcome(input: ApplyOutcomeInput): Promise<void> {
  const { supabase, item, outcome } = input;
  const nextStatus = nextExecutionStatusForOutcome(outcome);
  await supabase
    .from("execution_items")
    .update({
      status: nextStatus,
      metadata: {
        ...item.metadata,
        publish_outcome: {
          status: outcome.status,
          reason_code: outcome.reasonCode,
          reason_detail: outcome.reasonDetail,
          external_id: outcome.externalId,
          external_url: outcome.externalUrl,
        },
      },
    } as never)
    .eq("workspace_id", item.workspace_id)
    .eq("id", item.id);

  // Mirror status to the source plan item if known.
  //
  // Mirror lookup is driven by the execution_item's resolved
  // next-status (nextStatus, above) rather than the raw outcome:
  // a structural skip becomes execution_item.status='blocked' and
  // its plan_item moves to 'paused' to match. A transient skip
  // (e.g. scheduled_in_future) leaves the plan_item alone — the
  // execution_item remains 'scheduled' and the next tick retries.
  const planItemId =
    (item.metadata as { plan_item_id?: string }).plan_item_id ?? null;
  if (planItemId) {
    const planStatus =
      nextStatus === "completed"
        ? "published"
        : nextStatus === "blocked" || nextStatus === "failed"
          ? "paused"
          : null; // "scheduled" → no plan_item change
    if (planStatus) {
      await supabase
        .from("weekly_plan_items")
        .update({ status: planStatus } as never)
        .eq("workspace_id", item.workspace_id)
        .eq("id", planItemId);
    }
  }

  await supabase.from("execution_logs").insert({
    workspace_id: item.workspace_id,
    queue_id: item.queue_id,
    execution_item_id: item.id,
    event_type:
      outcome.status === "published"
        ? "item.completed"
        : outcome.status === "blocked"
        ? "item.blocked"
        : outcome.status === "failed"
        ? "item.failed"
        : "item.dry_run_finished",
    severity: outcome.status === "failed" || outcome.status === "blocked"
      ? "error"
      : "info",
    message: `[publisher] ${outcome.status} — ${outcome.reasonDetail ?? outcome.reasonCode}`,
    metadata: {
      reason_code: outcome.reasonCode,
      external_id: outcome.externalId,
      external_url: outcome.externalUrl,
      ...outcome.metadata,
    },
  } as never);
}

interface MarkReadyInput {
  supabase: NonNullable<ReturnType<typeof createSupabaseServiceRoleClient>>;
  item: {
    id: string;
    workspace_id: string;
    queue_id: string;
    metadata: Record<string, unknown>;
  };
  nowIso: string;
}

/**
 * Phase F2.5 — courier transition. Moves an eligible execution_item
 * from 'scheduled' to 'ready'. Does NOT call Reddit. Does NOT
 * mutate the source plan_item status — the plan_item stays
 * 'scheduled' until the operator confirms publish (or it's marked
 * 'published' / 'paused' downstream).
 */
async function markItemReadyForPublish(input: MarkReadyInput): Promise<void> {
  const { supabase, item, nowIso } = input;
  await supabase
    .from("execution_items")
    .update({
      status: "ready",
      metadata: {
        ...item.metadata,
        ready_for_publish_at: nowIso,
      },
    } as never)
    .eq("workspace_id", item.workspace_id)
    .eq("id", item.id);

  await supabase.from("execution_logs").insert({
    workspace_id: item.workspace_id,
    queue_id: item.queue_id,
    execution_item_id: item.id,
    event_type: "item.ready_for_publish",
    severity: "info",
    message:
      "[scheduler] Item moved to ready — operator must confirm at /execution.",
    metadata: { source: "safe_test_mode" },
  } as never);
}
