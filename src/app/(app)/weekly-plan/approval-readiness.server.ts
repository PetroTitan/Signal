import "server-only";

/**
 * Server-side approval-readiness assessor.
 *
 * Imports the server-only creative repository to call
 * `creativeReadinessReason`. Used exclusively by server actions in
 * `_actions.ts`. UI code MUST import the pure helpers from
 * `approval-readiness.shared.ts` instead — there is an
 * import-integrity regression test that fails CI if a UI file
 * (`"use client"` or its component graph) ever imports this module.
 */

import {
  creativeReadinessReason,
  type WeeklyPlanItemCreative,
} from "@/repositories/weekly-plan-creative-repository";
import type { WeeklyContract } from "@/core/weekly-contract/approval-contract-types";
import type { WeeklyPlanItem } from "@/repositories/weekly-plan-repository";
import {
  creativeBlockerCopy,
  type ApprovalReadiness,
  type CreativeReadinessCode,
} from "./approval-readiness.shared";
import {
  isApprovablePublishObject,
  requiresCreative,
} from "@/core/platform-native/approval-policy";
import {
  parsePlatformNativeShape,
  type PublishingIntent,
} from "@/core/platform-native";
import type { PublishPlatform } from "@/core/publishing/publishing-types";

export type { ApprovalReadiness } from "./approval-readiness.shared";
export { summarizeReadiness } from "./approval-readiness.shared";

export interface ApprovalReadinessInput {
  item: WeeklyPlanItem;
  /** Active workspace contract. Null when the operator has none —
   *  treated according to `requireContract`. */
  contract: WeeklyContract | null;
  /** Primary creative attached to the item (the first creative when
   *  multiple exist). Null when the item has no creative. */
  primaryCreative: WeeklyPlanItemCreative | null;
  /** Whether a schedule is required by the caller's path. Hold
   *  paths pass false; immediate-schedule paths pass true. */
  requireSchedule: boolean;
  /**
   * Statuses accepted by the caller's path. Defaults to
   * `["pending_approval"]` so existing callers are unaffected.
   *
   * `scheduleApprovedItemAction` (post-approval schedule) passes
   * `["approved"]` since the row is already past the approval gate.
   */
  allowedStatuses?: ReadonlyArray<string>;
  /**
   * Whether the caller's path needs an active weekly contract.
   *
   *   - Per-item HOLD path passes false. Holding doesn't insert into
   *     execution_items (which has `contract_id NOT NULL`) and
   *     doesn't enforce contract scope at this layer, so the
   *     contract is irrelevant.
   *   - Per-item IMMEDIATE-SCHEDULE path passes true. The
   *     execution_items row literally cannot be inserted without a
   *     contract_id.
   *   - Bulk plan-wide paths pass true (governance: bulk approval
   *     stays gated by an explicit weekly contract).
   *
   * When false, contract + scope checks are skipped entirely.
   */
  requireContract: boolean;
}

export function assessItemApprovalReadiness(
  input: ApprovalReadinessInput,
): ApprovalReadiness {
  const blockers: string[] = [];

  const allowedStatuses = input.allowedStatuses ?? ["pending_approval"];
  const statusPending = allowedStatuses.includes(input.item.status);
  if (!statusPending) {
    blockers.push(
      `Item is in status "${input.item.status}" — allowed: ${allowedStatuses.join(", ")}.`,
    );
  }

  const riskNotBlocked = input.item.riskLevel !== "blocked";
  if (!riskNotBlocked) {
    blockers.push("QA blocked this draft — risk level is 'blocked'.");
  }

  // Phase F7.4 — approvable publish object policy.
  //
  // The legacy gate rejected anything where content_type !== "post".
  // That blocked every dev.to / Hashnode / LinkedIn article and
  // every future article-shaped platform from ever reaching
  // approval. Approval now consults the central platform-native
  // policy to decide whether the item's (platform, content_type,
  // intent) tuple is a publishable object.
  //
  // The intent is parsed from platform_publish_intent (when set);
  // legacy rows with content_type='post' continue to pass.
  const intent = readIntentFromItem(input.item);
  const approvableObject = isApprovablePublishObject({
    platform: input.item.platform,
    contentType: input.item.contentType,
    intent,
  });
  if (!approvableObject) {
    blockers.push("This item is not a publishable platform object yet.");
  }

  // Phase F7.3 — platform-native approval policy.
  //
  // The legacy assumption was "every post needs a creative" — that
  // doesn't fit article / text-first platforms (dev.to, Hashnode,
  // Reddit text, LinkedIn article, Bluesky text, X text, Telegram).
  // We now consult `requiresCreative` from the central policy
  // module to decide whether the creative gate runs.
  //
  // Behavior:
  //   - creativeRequired = true (e.g. Instagram, YouTube video_post,
  //     intent ∈ {media_post, carousel, story, short_video}) →
  //     existing strict gate; missing/invalid creative blocks.
  //   - creativeRequired = false → never block on creative at the
  //     approval layer. Adapters still validate at render / publish
  //     time when a creative IS attached (Bluesky alt-text, etc.).
  //
  // The informational copy "Creative optional for this platform/
  // format." is emitted on the readiness output when the policy
  // says optional AND no creative is attached, so the UI can show a
  // neutral note instead of red blocker text.
  const creativeRequired = requiresCreative({
    platform: input.item.platform,
    intent,
  });

  const creativeReasonCode = creativeReadinessReason(input.primaryCreative);
  let creativeReady: boolean;
  if (creativeRequired) {
    creativeReady = creativeReasonCode === null;
    if (!creativeReady) {
      blockers.push(
        creativeBlockerCopy(creativeReasonCode as CreativeReadinessCode | null),
      );
    }
  } else {
    // Optional policy: approval is never blocked on creative.
    // creativeReady reflects whether the gate WOULD have passed (so
    // observability stays accurate), but we don't push a blocker.
    creativeReady = true;
  }

  const informational: string[] = [];
  if (!creativeRequired && input.primaryCreative === null) {
    informational.push("Creative optional for this platform/format.");
  }

  // Contract handling — gated by requireContract.
  //
  // When the caller's path does NOT need a contract (per-item hold),
  // we report contractActive=true (so the ok-flag tells the UI the
  // path is unblocked) and skip the scope checks entirely.
  //
  // When the path DOES need one, we surface the blocker and run
  // scope checks against it.
  let contractActive = true;
  let accountScope = true;
  let productScope = true;
  let platformScope = true;
  if (input.requireContract) {
    contractActive = input.contract !== null;
    if (!contractActive) {
      blockers.push(
        "Scheduling requires an active weekly contract. You can approve & hold now, then activate a contract before scheduling.",
      );
    }
    if (input.contract) {
      if (
        input.item.accountId &&
        !input.contract.scope.accountIds.includes(input.item.accountId)
      ) {
        accountScope = false;
        blockers.push("Account is out of the active contract's scope.");
      }
      if (
        input.item.productId &&
        !input.contract.scope.productIds.includes(input.item.productId)
      ) {
        productScope = false;
        blockers.push("Product is out of the active contract's scope.");
      }
      if (
        input.item.platform &&
        !input.contract.scope.platforms.includes(input.item.platform)
      ) {
        platformScope = false;
        blockers.push("Platform is out of the active contract's scope.");
      }
    }
  }

  const scheduleSet = input.item.scheduledAt !== null;
  if (input.requireSchedule && !scheduleSet) {
    blockers.push(
      "Schedule is required before approving with immediate scheduling. Use Approve & hold to defer.",
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    informational,
    ok: {
      statusPending,
      riskNotBlocked,
      approvableObject,
      creativeReady,
      contractActive,
      accountScope,
      productScope,
      platformScope,
      scheduleSet,
      creativeRequired,
    },
  };
}

/**
 * Phase F7.3 — parse the operator's intent off the plan item's
 * `platform_publish_intent` JSONB envelope. The platform-native
 * shape parser is strict about platform mismatch; here we use the
 * item's own platform as the expected platform (the policy only
 * cares about the intent string, not the rest of the envelope).
 *
 * Returns:
 *   - the intent string when the envelope parses cleanly
 *   - null otherwise (legacy rows, malformed envelopes, no platform)
 *
 * Null intent → policy default ("optional" for most platforms; still
 * "required" for Instagram via the platform-level rule).
 */
function readIntentFromItem(item: WeeklyPlanItem): PublishingIntent | null {
  if (!item.platform) return null;
  const raw = item.platformPublishIntent;
  if (!raw) return null;
  const parsed = parsePlatformNativeShape(raw, item.platform as PublishPlatform);
  return parsed?.intent ?? null;
}
