/**
 * Canonical publish-blocker model — the single answer to "why can't
 * this post go out, and what exactly must the operator do?"
 *
 * The incident this exists to prevent
 * ----------------------------------
 * A Bluesky post sat `paused` while the card simultaneously displayed:
 *
 *     "Creative approved"                                    (true)
 *     "Creative must be approved before the post itself can
 *      be approved. Approve the creative below…"             (false)
 *
 * The first came from `describeCreativeState()`, derived from the real
 * creative row. The second came from a hardcoded banner with no
 * inputs, rendered whenever a creative existed at all — pointing at
 * approve/reject buttons that were correctly hidden because the
 * creative was already approved.
 *
 * Meanwhile the ACTUAL blocker was invisible: the execution item had
 * been refused at the publishing policy gate with
 * `account_not_confirmed`, because it carried no `account_id` at all —
 * no approval gate had ever required a publishing identity. The
 * operator was told to fix a creative that was already fine, while the
 * real problem (no identity attached) was never mentioned on any
 * surface.
 *
 * The rule this module encodes
 * ----------------------------
 * A blocker is a FACT DERIVED FROM STATE, never a constant. Every
 * surface that tells an operator why something is stuck must render
 * from this evaluator, so the card, the compose footer and the server
 * action cannot disagree.
 *
 * Four states are kept SEPARATE and never collapsed into one badge:
 * an approved creative stays approved even when the post is blocked
 * for an unrelated reason.
 *
 * Pure. No I/O, no `server-only`. Safe on both server and client —
 * which is the point: the server action and the card must consult the
 * same function.
 */

import { requiresCreative, requiresTitle } from "@/core/platform-native/approval-policy";
import type { PublishingIntent } from "@/core/platform-native/publishing-intent";
import { allowsOperatorTarget } from "./publish-destinations";

// =====================================================================
// Blocker codes
// =====================================================================
//
// snake_case, matching the `PublishReasonCode` convention so operator
// copy, logs and tests speak one vocabulary.

export const PUBLISH_BLOCKER_CODES = [
  "post_status_not_approvable",
  "risk_level_blocked",
  "object_not_publishable",
  "body_required",
  "title_required",
  "schedule_required",
  "operator_target_required",
  /** No publishing identity attached. THE INCIDENT. */
  "identity_not_attached",
  "creative_missing",
  "creative_pending_review",
  "creative_rejected",
  "creative_missing_asset",
  "creative_missing_alt_text",
  "contract_missing",
  "contract_scope_account",
  "contract_scope_product",
  "contract_scope_platform",
] as const;

export type PublishBlockerCode = (typeof PUBLISH_BLOCKER_CODES)[number];

export interface PublishBlocker {
  code: PublishBlockerCode;
  /** The row the operator must act on: the creative id for creative
   *  blockers, the plan item id otherwise. Lets a surface deep-link
   *  straight to the thing that needs fixing. */
  entityId: string | null;
  /** One sentence, imperative, naming the action. Never a rule
   *  statement — "Add alt text before approving the post", not
   *  "Creatives must have alt text". */
  message: string;
}

export interface PublishBlockerVerdict {
  canApprovePost: boolean;
  blockers: PublishBlocker[];
  /**
   * Things the operator should know that do NOT stop approval.
   *
   * The distinction is load-bearing. `resolvePublishCreative` filters
   * to `status === "approved"`, so a creative still awaiting review is
   * silently dropped and the post publishes text-only. That is a real
   * surprise worth surfacing — but it is not a blocker, and reporting
   * it as one is what the incident banner did.
   */
  warnings: PublishBlocker[];
}

// =====================================================================
// Independent state axes
// =====================================================================
//
// Deliberately four separate values. Collapsing them is what produced
// the incident: a blocked POST was rendered as if the CREATIVE were
// the problem.

export type CreativeState =
  | "none"
  | "planned"
  | "awaiting_approval"
  | "approved"
  | "rejected";

export type PostApprovalState =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "scheduled"
  | "published"
  | "paused"
  | "rejected"
  | "other";

export type ExecutionState =
  | "not_created"
  | "pending"
  | "scheduled"
  | "ready_for_manual_publish"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * What actually happened at the provider boundary. Derived from the
 * PERSISTED `execution_items.metadata.publish_outcome`, never from
 * local UI state.
 *
 *   - not_attempted          no outcome recorded yet
 *   - refused_before_provider a gate refused; no provider call was made
 *   - unknown                 dispatched, never confirmed (P0.2 class C)
 *   - partial                 some parts live (P0.2 class D)
 *   - published               confirmed live (P0.2 class E)
 *   - failed                  provider answered with an error
 */
export type PublishingState =
  | "not_attempted"
  | "refused_before_provider"
  | "unknown"
  | "partial"
  | "published"
  | "failed";

// =====================================================================
// Inputs — structural, not repository types, so this stays pure
// =====================================================================

export interface BlockerCreativeInput {
  id: string;
  /** weekly_plan_item_creatives.status */
  status: string | null;
  sourceType: string | null;
  assetUrl: string | null;
  sourceUrl: string | null;
  altText: string | null;
}

export interface BlockerItemInput {
  id: string;
  status: string;
  platform: string | null;
  contentType: string | null;
  intent: PublishingIntent | null;
  title: string | null;
  body: string | null;
  /** growth_accounts.id — the publishing identity. */
  accountId: string | null;
  scheduledAt: string | null;
  riskLevel: string | null;
  /** weekly_plan_items.metadata, for the operator-typed routing target. */
  metadata: Record<string, unknown> | null;
}

export interface EvaluatePublishBlockersInput {
  item: BlockerItemInput;
  creative: BlockerCreativeInput | null;
  /** Statuses this caller accepts. Defaults to the approval gate's. */
  allowedStatuses?: ReadonlyArray<string>;
  /** True when the caller is about to create an execution item and so
   *  needs a publish time. Hold paths pass false. */
  requireSchedule: boolean;
  /**
   * True when the caller is about to create an execution item at all.
   *
   * The identity guard is scoped to these paths on purpose: parking a
   * post with "approve & hold" before choosing an identity is a
   * legitimate way to work, and blocking it would be a worse product
   * than the bug. What must never happen is an execution item reaching
   * the scheduler with no identity to publish as.
   */
  requireIdentity: boolean;
}

// =====================================================================
// Creative state — one derivation, used everywhere
// =====================================================================

export function resolveCreativeState(
  creative: BlockerCreativeInput | null,
): CreativeState {
  if (!creative) return "none";
  if (creative.status === "rejected") return "rejected";
  if (creative.status === "approved") return "approved";
  if (creative.sourceType === "planned") return "planned";
  return "awaiting_approval";
}

/** True when the attached creative is well-formed enough to publish. */
function creativeAssetPresent(creative: BlockerCreativeInput): boolean {
  return Boolean(creative.assetUrl ?? creative.sourceUrl);
}

// =====================================================================
// The evaluator
// =====================================================================

/**
 * Every reason this post cannot be approved right now, as structured
 * facts.
 *
 * Order is operator-priority: the thing they must fix first comes
 * first, so a surface that shows only one blocker shows the right one.
 */
export function evaluatePublishBlockers(
  input: EvaluatePublishBlockersInput,
): PublishBlockerVerdict {
  const blockers: PublishBlocker[] = [];
  const warnings: PublishBlocker[] = [];
  const { item, creative } = input;
  const itemId = item.id;

  const allowedStatuses = input.allowedStatuses ?? ["pending_approval"];
  if (!allowedStatuses.includes(item.status)) {
    blockers.push({
      code: "post_status_not_approvable",
      entityId: itemId,
      message: `This post is "${item.status}" — it cannot be approved from here.`,
    });
  }

  if (item.riskLevel === "blocked") {
    blockers.push({
      code: "risk_level_blocked",
      entityId: itemId,
      message: "QA blocked this draft. Rewrite it before approving.",
    });
  }

  // Content. A titleless social post is legitimate (see requiresTitle);
  // an empty body never is.
  if (!item.body || item.body.trim().length === 0) {
    blockers.push({
      code: "body_required",
      entityId: itemId,
      message: "Write the post before approving it.",
    });
  }
  if (
    requiresTitle({
      platform: item.platform,
      contentType: item.contentType,
      intent: item.intent,
    }) &&
    (!item.title || item.title.trim().length === 0)
  ) {
    blockers.push({
      code: "title_required",
      entityId: itemId,
      message: "Add a title before approving this post.",
    });
  }

  // THE INCIDENT. An item with no publishing identity was approved and
  // scheduled; the scheduler then could not find an account row, so
  // `accountReviewStatus` resolved to null and the policy gate refused
  // with `account_not_confirmed` — a message describing a confirmation
  // problem when the truth was that there was no identity at all.
  if (input.requireIdentity && !item.accountId) {
    blockers.push({
      code: "identity_not_attached",
      entityId: itemId,
      message:
        "Choose the identity to publish as. Open the post and pick one under Identity.",
    });
  }

  // Creative. Split into distinct causes: "approved but missing alt
  // text" must never be reported as "needs approval".
  const creativeRequired = requiresCreative({
    platform: item.platform,
    intent: item.intent,
  });
  const creativeState = resolveCreativeState(creative);

  if (creativeRequired && (!creative || creativeState === "planned")) {
    blockers.push({
      code: "creative_missing",
      entityId: itemId,
      message: "Attach a creative before approving this post.",
    });
  }
  if (creative) {
    if (creativeState === "rejected") {
      // A rejected creative blocks only where one is required; on a
      // text-first platform the post can go out without it.
      (creativeRequired ? blockers : warnings).push({
        code: "creative_rejected",
        entityId: creative.id,
        message: creativeRequired
          ? "The creative was rejected. Replace it before approving."
          : "The creative was rejected, so this post will publish without an image.",
      });
    } else if (creativeState === "awaiting_approval") {
      // NOT a blocker on optional-creative platforms.
      // `resolvePublishCreative` only ever publishes creatives whose
      // status is "approved", so an unreviewed one is silently dropped
      // and the post goes out text-only. The operator needs to know
      // that — but telling them the POST is blocked would be false,
      // and is exactly what the incident banner did.
      (creativeRequired ? blockers : warnings).push({
        code: "creative_pending_review",
        entityId: creative.id,
        message: creativeRequired
          ? "Approve the creative before approving the post."
          : "Approve the creative, or this post publishes without the image.",
      });
    }

    // Asset and alt text are evaluated INDEPENDENTLY of approval
    // status, and only bite once the creative is approved — because
    // that is precisely when the publisher will try to use it.
    // `resolvePublishCreative` returns a hard `blocked` outcome
    // (creative_missing_asset / creative_missing_alt_text) for an
    // APPROVED creative missing either, so catching it at approval
    // time is the difference between a fixable warning and a terminal
    // publish failure.
    if (creativeState === "approved") {
      if (!creativeAssetPresent(creative)) {
        blockers.push({
          code: "creative_missing_asset",
          entityId: creative.id,
          message: "The creative has no image file. Re-upload it.",
        });
      }
      if (!creative.altText || creative.altText.trim().length === 0) {
        blockers.push({
          code: "creative_missing_alt_text",
          entityId: creative.id,
          message: "Add alt text before approving the post.",
        });
      }
    }
  }

  if (input.requireSchedule && item.scheduledAt === null) {
    blockers.push({
      code: "schedule_required",
      entityId: itemId,
      message: "Set a publish time, or use Approve & hold.",
    });
  }

  // Gated on requireSchedule for the same reason the schedule blocker
  // is: "approve & hold" legitimately parks a post before the operator
  // has chosen a subreddit. Only the paths that mint an execution item
  // demand one.
  if (input.requireSchedule && allowsOperatorTarget(item.platform)) {
    const raw = (item.metadata as { target?: unknown } | null)?.target;
    const target = typeof raw === "string" ? raw.trim() : "";
    if (target.length === 0) {
      blockers.push({
        code: "operator_target_required",
        entityId: itemId,
        message: "Add a target subreddit before scheduling.",
      });
    }
  }

  return { canApprovePost: blockers.length === 0, blockers, warnings };
}

// =====================================================================
// Publishing state — read the PERSISTED outcome, never infer
// =====================================================================

export interface PersistedPublishOutcome {
  status?: unknown;
  reason_code?: unknown;
  reason_detail?: unknown;
  external_id?: unknown;
  external_url?: unknown;
}

/**
 * Reason codes produced by gates that refuse BEFORE any provider call.
 * Mirrors `evaluatePublishingPolicy` plus the scheduler's own
 * pre-dispatch refusals. Kept here so a surface can tell an operator
 * "nothing was sent" with confidence rather than "it failed".
 */
const REFUSED_BEFORE_PROVIDER: ReadonlySet<string> = new Set([
  "account_not_confirmed",
  "product_not_confirmed",
  "oauth_not_connected",
  "oauth_token_not_stored",
  "publishing_disabled",
  "execution_mode_dry_run",
  "scheduled_in_future",
  "risk_level_blocked",
  "platform_not_supported",
  "no_active_contract",
  "cadence_cooldown",
  "duplicate_post",
  "missing_subreddit",
  "missing_title",
  "missing_body",
  "missing_api_key",
  "missing_publication_id",
  "missing_identifier",
  "creative_missing_asset",
  "creative_missing_alt_text",
  "approved_shape_stale",
  "single_post_exceeds_budget",
  "reddit_autonomous_publish_disabled",
  "subreddit_not_allowlisted",
]);

/**
 * What happened at the provider boundary, from persisted truth.
 *
 * Provider evidence outranks the status field — matching
 * `retry-eligibility`: an outcome carrying an external id or URL is
 * `published` no matter what `status` says.
 */
export function resolvePublishingState(
  outcome: PersistedPublishOutcome | null | undefined,
): PublishingState {
  if (!outcome) return "not_attempted";

  const externalId =
    typeof outcome.external_id === "string" ? outcome.external_id.trim() : "";
  const externalUrl =
    typeof outcome.external_url === "string" ? outcome.external_url.trim() : "";
  if (externalId.length > 0 || externalUrl.length > 0) return "published";

  const status = typeof outcome.status === "string" ? outcome.status : "";
  if (status === "published") return "published";

  const reasonCode =
    typeof outcome.reason_code === "string" ? outcome.reason_code : "";
  if (reasonCode === "publish_partial_success") return "partial";
  if (reasonCode === "publish_outcome_unknown") return "unknown";
  if (REFUSED_BEFORE_PROVIDER.has(reasonCode)) return "refused_before_provider";

  if (status === "failed" || status === "blocked") return "failed";
  return "not_attempted";
}

/** True when the provider was definitely never contacted. */
export function providerWasAttempted(
  outcome: PersistedPublishOutcome | null | undefined,
): boolean {
  const state = resolvePublishingState(outcome);
  return state !== "not_attempted" && state !== "refused_before_provider";
}
