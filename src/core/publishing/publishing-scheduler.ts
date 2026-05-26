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
 * Resolve the workspace's publish mode from its settings row.
 *
 * IMPORTANT: default is `"live"`. `"dry_run"` is an EXPLICIT opt-in.
 * The pre-fix default was `"dry_run"` unless `execution_mode === "live"`,
 * but `workspace_settings` has no `execution_mode` column on the
 * live schema, so the field was always undefined and every workspace
 * silently published in dry-run mode (every scheduler tick fired
 * `publishSkip("execution_mode_dry_run")` and after PR #95 those
 * items transitioned to `blocked`).
 *
 * Exported for testing. Pure — no I/O.
 */
export function resolvePublishMode(
  settings: { execution_mode?: string | null } | null | undefined,
): PublishMode {
  return settings?.execution_mode === "dry_run" ? "dry_run" : "live";
}

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

    // Per-item iteration runs entirely inside this try/catch — any
    // exception (including from applyOutcome itself, the safe-test
    // import, markItemReadyForPublish, supabase writes, …) is
    // captured and converted into a `scheduler_exception` outcome
    // that's persisted to the DB. The previous PR (#95) wrapped
    // only publishOne; this widens the guard so the
    // "silent-scheduled-forever" failure mode has no remaining
    // escape paths.
    let outcome: PublishOutcome;
    try {
      if (!SCHEDULER_AUTONOMOUS_PLATFORMS.has(platform)) {
        // Unsupported platform — was previously an in-memory skip
        // that left status='scheduled' forever. Now goes through
        // applyOutcome as a "blocked" terminal so the operator can
        // see the actual rejected platform value via
        // execution_items.metadata.publish_outcome.reason_detail.
        outcome = {
          status: "blocked",
          reasonCode: "platform_not_supported",
          reasonDetail: `Item has unsupported platform "${raw.platform ?? "null"}".`,
          externalId: null,
          externalUrl: null,
          metadata: {},
        };
        await applyOutcome({ supabase, item: raw, outcome });
      } else {
        // Phase F2.5 — under SAFE_TEST_MODE the scheduler is a
        // courier for reddit only. Other platforms go through the
        // normal publish path.
        const { safeTestModeEnabled } = await import("./safe-test-env");
        if (safeTestModeEnabled() && platform === "reddit") {
          await markItemReadyForPublish({
            supabase,
            item: raw,
            nowIso,
          });
          outcome = {
            status: "skipped",
            reasonCode: "safe_test_mode_ready_for_publish",
            reasonDetail:
              "Item marked ready_for_publish — operator must confirm at /execution.",
            externalId: null,
            externalUrl: null,
            metadata: {},
          };
          // markItemReadyForPublish already wrote the DB
          // transition (status='ready'). Don't double-write via
          // applyOutcome.
        } else {
          outcome = await publishOne({
            supabase,
            nowIso,
            item: raw,
            platform,
          });
        }
      }
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
      // Persist defensively. If applyOutcome ITSELF throws (DB
      // write failed, schema mismatch, network blip) the iteration
      // ends but the batch loop continues — the next tick will
      // re-select the row and retry. Better than dying for the
      // whole tick.
      try {
        await applyOutcome({ supabase, item: raw, outcome });
      } catch (applyErr) {
        // Defensive last resort — log to console only; the row
        // stays at status='scheduled' but the next tick will
        // re-attempt. No silent fallthrough beyond this point.
        // eslint-disable-next-line no-console
        console.error(
          "[publishing-scheduler] applyOutcome failed for execution_item",
          raw.id,
          applyErr,
        );
      }
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
    platform: string | null;
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
  //
  // Default is `live` — dry_run is an EXPLICIT opt-in via
  // `workspace_settings.execution_mode = "dry_run"`. Prior to this
  // change the default was "dry_run" unless the row had
  // `execution_mode === "live"`, but the column doesn't exist on
  // `workspace_settings` (verified against the live schema), so the
  // value was always undefined at runtime and every workspace
  // silently published in dry-run mode. No scheduler-tick publish
  // ever reached the platform API.
  //
  // Other publish-time safety gates (account confirmed, oauth
  // connected, token stored, risk-not-blocked, scheduled_at <= now)
  // remain intact and run AFTER this mode resolution. Operators who
  // need dry-run for testing can set the column explicitly (a future
  // migration can add the column with default "live").
  //
  // The SAFE_TEST_MODE env var still gates Reddit in courier mode
  // upstream of this check — it's a process-level safety, separate.
  const { data: settings } = await supabase
    .from("workspace_settings")
    .select("*")
    .eq("workspace_id", item.workspace_id)
    .maybeSingle();
  const mode: PublishMode = resolvePublishMode(
    settings as { execution_mode?: string | null } | null,
  );

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

  // Approved creative pickup. Only the Bluesky publisher reads media
  // today; loading is platform-gated so we don't pay the read for
  // text-only adapters. The scheduler uses its service-role client
  // because the cron runtime has no operator cookie (same RLS reason
  // as the orchestrator's repo plumbing).
  //
  // If an approved creative exists but is malformed (no asset URL or
  // no alt text), we BLOCK the publish here rather than letting the
  // publisher silently downgrade to text-only. The operator gets a
  // clear reason code (creative_missing_asset / creative_missing_alt_text)
  // they can act on.
  let publishCreative: import("./publishing-types").PublishCreative | null = null;
  const planItemId =
    (item.metadata as { plan_item_id?: string })?.plan_item_id ?? "";
  if (platform === "bluesky" && planItemId) {
    const { listCreativesForItem } = await import(
      "@/repositories/weekly-plan-creative-repository"
    );
    const { resolvePublishCreative } = await import(
      "./resolve-publish-creative"
    );
    const creatives = await listCreativesForItem(
      item.workspace_id,
      planItemId,
      supabase as never,
    );
    const decision = resolvePublishCreative(creatives);
    if (decision.kind === "blocked") {
      return {
        status: "blocked",
        reasonCode: decision.reasonCode,
        reasonDetail: decision.reasonDetail,
        externalId: null,
        externalUrl: null,
        metadata: {
          creative_id: decision.creativeId,
          plan_item_id: planItemId,
        },
      };
    }
    if (decision.kind === "ready") {
      publishCreative = decision.creative;
    }
  }

  const outcome = await runPublish({
    request: {
      workspaceId: item.workspace_id,
      planItemId,
      executionItemId: item.id,
      platform,
      accountId: item.account_id ?? "",
      productId: item.product_id,
      title: item.title,
      body: item.body,
      linkUrl: item.link_url,
      target,
      mode,
      creative: publishCreative,
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
    // Thread the service-role client down so the Bluesky orchestrator
    // can re-read growth_accounts / platform_connections under cron
    // runtime (no operator cookie). Other adapters ignore `db` — they
    // publish via env credentials or HTTP fetch. See PR commit message
    // for the RLS root cause.
    db: supabase as never,
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
  /**
   * Full execution_items row. Widened from the previous {id,
   * workspace_id, queue_id, metadata} shape so applyOutcome can
   * also write a publish_history row with the per-item identifiers
   * (account_id, product_id, platform) + the content the duplicate-
   * fingerprint check uses (title, body, link_url).
   */
  item: {
    id: string;
    workspace_id: string;
    queue_id: string;
    account_id: string | null;
    product_id: string | null;
    platform: string | null;
    title: string | null;
    body: string | null;
    link_url: string | null;
    metadata: Record<string, unknown>;
  };
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

  // publish_history persistence (fix/scheduler-write-publish-history).
  //
  // Write a row for every terminal outcome (completed / failed /
  // blocked). The repository helper handles dedup at the
  // (execution_item_id, mode='api') level: existing manual rows are
  // never touched; existing 'published' rows are never downgraded by
  // a later 'failed'/'blocked' attempt.
  //
  // Skips:
  //   - "skipped" outcomes (transient — item stays scheduled).
  //   - "not_implemented" outcomes.
  //
  // Failures here are LOGGED but never abort the tick — the
  // execution_items + execution_logs writes have already succeeded;
  // a publish_history hiccup must not roll back the canonical state.
  if (
    nextStatus === "completed" ||
    nextStatus === "failed" ||
    nextStatus === "blocked"
  ) {
    try {
      const historyOutcome: "published" | "failed" | "blocked" =
        outcome.status === "published"
          ? "published"
          : outcome.status === "blocked"
          ? "blocked"
          : "failed";
      const { computeFingerprint } = await import("./publish-fingerprint");
      const target =
        typeof (item.metadata as { target?: string })?.target === "string"
          ? ((item.metadata as { target: string }).target)
          : null;
      const fingerprint = await computeFingerprint({
        platform: item.platform ?? "",
        subreddit: target,
        title: item.title,
        body: item.body,
        linkUrl: item.link_url,
      });
      // Whitelist of outcome.metadata fields we lift onto the
      // publish_history row. NEVER copy outcome.metadata wholesale —
      // that's the only place a future publisher change could leak
      // a token-shaped value into the canonical history.
      const meta = outcome.metadata as Record<string, unknown>;
      const httpStatus =
        typeof meta.http_status === "number" ? meta.http_status : null;
      const endpoint =
        typeof meta.endpoint === "string" ? meta.endpoint : null;
      const atprotoError =
        typeof meta.atproto_error === "string" ? meta.atproto_error : null;
      const atprotoMessage =
        typeof meta.atproto_message === "string" ? meta.atproto_message : null;
      const threadLength =
        typeof meta.thread_length === "number" ? meta.thread_length : null;
      const mediaAttached =
        typeof meta.media_attached === "boolean" ? meta.media_attached : null;
      const contractMode =
        typeof (item.metadata as { contract_mode?: string })?.contract_mode ===
        "string"
          ? ((item.metadata as { contract_mode: string }).contract_mode)
          : null;
      // Provider boundary: we reached the platform iff a structured
      // endpoint (and therefore an HTTP status) made it back. Pre-
      // provider blocks (creative_missing_*, missing_body, etc.)
      // never set `endpoint`.
      const providerAttempted = endpoint !== null;

      const { upsertSchedulerPublishHistoryFromOutcome } = await import(
        "@/repositories/publish-history-repository"
      );
      await upsertSchedulerPublishHistoryFromOutcome({
        workspaceId: item.workspace_id,
        executionItemId: item.id,
        accountId: item.account_id,
        productId: item.product_id,
        platform: item.platform ?? "",
        subreddit: target,
        outcome: historyOutcome,
        reasonCode: outcome.reasonCode ?? null,
        reasonDetail: outcome.reasonDetail ?? null,
        providerPostId: outcome.externalId,
        providerPermalink: outcome.externalUrl,
        fingerprint: fingerprint.fingerprint,
        titleHash: fingerprint.titleHash,
        bodyHash: fingerprint.bodyHash,
        linkUrl: item.link_url,
        httpStatus,
        startedAt: new Date().toISOString(),
        providerAttempted,
        threadLength,
        mediaAttached,
        endpoint,
        atprotoError,
        atprotoMessage,
        contractMode,
        db: supabase as never,
      });
    } catch (err) {
      console.error(
        "[publishing-scheduler] publish_history upsert failed",
        err,
      );
    }
  }
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
