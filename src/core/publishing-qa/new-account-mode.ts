/**
 * New-account safety caps.
 *
 * Derived from the existing ACCOUNT_HEALTH_POLICY constants. This
 * module exposes a typed function the draft generator and QA
 * orchestrator can both read, so the warm-up window is enforced in
 * one place instead of being scattered across risk score and
 * generation prompt rules.
 */

import { ACCOUNT_HEALTH_POLICY } from "@/core/operational-safety/account-health-policy";
import type { NewAccountCaps, QaIdentity } from "./types";

/**
 * Platforms that punish thread-style multi-post bursts the hardest
 * during ramp. We block threads for warming accounts on these.
 */
const THREAD_RISKY_PLATFORMS = new Set([
  "x",
  "reddit",
  "linkedin",
  "threads",
  "instagram",
]);

export function newAccountCaps(identity: QaIdentity): NewAccountCaps {
  const warmUp = ACCOUNT_HEALTH_POLICY.warmUpDays;
  const isNew =
    identity.ageDays < warmUp ||
    identity.status === "warming" ||
    identity.status === "planned" ||
    identity.status === "setup_needed" ||
    identity.status === "awaiting_manual_creation";
  const warmUpDaysRemaining = Math.max(0, warmUp - identity.ageDays);

  if (!isNew) {
    return {
      isNewAccount: false,
      maxItemsPerWeek: ACCOUNT_HEALTH_POLICY.highVelocityThreshold,
      maxOutboundLinksPerItem: 2,
      allowThreads: true,
      allowLaunchLanguage: true,
      maxHashtagsPerItem: 5,
      warmUpDaysRemaining: 0,
    };
  }

  return {
    isNewAccount: true,
    // Warming: ~2 items/week max, deliberately under the high-
    // velocity threshold so risk scoring also stays calm.
    maxItemsPerWeek: 2,
    // Warming: prefer organic native content. One outbound link per
    // item, never more.
    maxOutboundLinksPerItem: 1,
    allowThreads: !THREAD_RISKY_PLATFORMS.has(identity.platform),
    allowLaunchLanguage: false,
    // Warming: hashtag spam is the fastest way to look automated.
    maxHashtagsPerItem: 2,
    warmUpDaysRemaining,
  };
}
