import "server-only";
/**
 * Phase F4.1 — cadence cooldowns.
 *
 * Per-platform soft warnings to prevent burst publishing without
 * gamifying it or scaring the founder. These are SOFT — they surface
 * a recommendation, never block. Only the founder's own action
 * triggers a publish, so this is genuinely advisory.
 *
 * Cooldown windows (chosen to feel like a calm human cadence, not
 * "anti-spam panic"):
 *   - dev.to:    108 minutes (~1.8 hours)
 *   - Hashnode:  100 minutes
 *   - Bluesky:   120 minutes (Bluesky is the most sensitive to bursts)
 *
 * Reddit / X / LinkedIn don't get cooldowns here — they have their
 * own platform-side rate limits + the existing safe-test gates.
 *
 * Only counts SUCCESSFUL publishes. Failures and blocks don't push
 * the cooldown forward, so retrying a failed publish isn't penalized.
 */

import { createSupabaseServerClient } from "@/lib/supabase";
import type { PublishPlatform } from "./publishing-types";

const COOLDOWN_MINUTES: Partial<Record<PublishPlatform, number>> = {
  devto: 108,
  hashnode: 100,
  bluesky: 120,
  // F5.0 — distribution layers. Manual posting reality means these
  // cooldowns are guidance for the founder's cadence, not API
  // throttles. X tolerates more frequent posting than LinkedIn,
  // which surfaces aggressive posting as low-quality activity in its
  // feed ranking.
  x: 180,
  linkedin: 480,
  // F5.1 — new platforms.
  //   youtube  — video work takes hours; 12h between publishes is generous
  //   threads  — short conversational; 3h matches X cadence target
  //   instagram— visual prep needed; 4h respects feed-ranking penalties
  //   telegram — semi-automated bot post; 30m prevents accidental spam
  youtube: 720,
  threads: 180,
  instagram: 240,
  telegram: 30,
};

export type CadenceHealth = "healthy" | "slightly_aggressive" | "aggressive";

export interface CadenceState {
  /** Configured cooldown for this platform, in minutes; null when none. */
  cooldownMinutes: number | null;
  /** Minutes elapsed since the most recent successful publish; null when never. */
  minutesSinceLast: number | null;
  /** ISO timestamp of the last successful publish, or null. */
  lastPublishedAt: string | null;
  /** True when more time should pass before the next publish. */
  recommendWaiting: boolean;
  /** Minutes the founder is recommended to wait. 0 when ready. */
  minutesRemaining: number;
  health: CadenceHealth;
}

/**
 * Look up the most recent successful publish on a (workspace, platform)
 * and compute the cadence state for the next attempt.
 */
export async function checkCadence(input: {
  workspaceId: string;
  platform: PublishPlatform;
}): Promise<CadenceState> {
  const cooldown = COOLDOWN_MINUTES[input.platform] ?? null;

  if (!cooldown) {
    return {
      cooldownMinutes: null,
      minutesSinceLast: null,
      lastPublishedAt: null,
      recommendWaiting: false,
      minutesRemaining: 0,
      health: "healthy",
    };
  }

  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from("publish_history")
    .select("finished_at")
    .eq("workspace_id", input.workspaceId)
    .eq("platform", input.platform)
    .eq("outcome", "published")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastPublishedAt =
    (data as { finished_at?: string } | null)?.finished_at ?? null;
  if (!lastPublishedAt) {
    return {
      cooldownMinutes: cooldown,
      minutesSinceLast: null,
      lastPublishedAt: null,
      recommendWaiting: false,
      minutesRemaining: 0,
      health: "healthy",
    };
  }

  const lastMs = new Date(lastPublishedAt).getTime();
  if (Number.isNaN(lastMs)) {
    return {
      cooldownMinutes: cooldown,
      minutesSinceLast: null,
      lastPublishedAt,
      recommendWaiting: false,
      minutesRemaining: 0,
      health: "healthy",
    };
  }
  const minutesSinceLast = Math.floor((Date.now() - lastMs) / 60000);
  const minutesRemaining = Math.max(0, cooldown - minutesSinceLast);
  const recommendWaiting = minutesRemaining > 0;

  // Heuristic health bands. Aggressive = >50% of cooldown still to go.
  let health: CadenceHealth = "healthy";
  if (minutesRemaining > cooldown / 2) {
    health = "aggressive";
  } else if (minutesRemaining > 0) {
    health = "slightly_aggressive";
  }

  return {
    cooldownMinutes: cooldown,
    minutesSinceLast,
    lastPublishedAt,
    recommendWaiting,
    minutesRemaining,
    health,
  };
}

/**
 * Human-readable founder message for the cadence state. Calm, no
 * scary "anti-spam" language. Caller is responsible for placing this
 * in an amber soft-warning panel.
 */
export function cadenceMessage(state: CadenceState, platform: string): string {
  if (!state.recommendWaiting) return "";
  const label = friendlyPlatformLabel(platform);
  return `${label} was used recently. Waiting another ${state.minutesRemaining} minute${
    state.minutesRemaining === 1 ? "" : "s"
  } is recommended before publishing again.`;
}

function friendlyPlatformLabel(platform: string): string {
  switch (platform) {
    case "devto":
      return "dev.to";
    case "hashnode":
      return "Hashnode";
    case "bluesky":
      return "Bluesky";
    case "reddit":
      return "Reddit";
    case "x":
      return "X";
    case "linkedin":
      return "LinkedIn";
    default:
      return platform;
  }
}
