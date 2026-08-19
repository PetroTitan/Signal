/**
 * Operator recommendations (PURE).
 *
 * HARD BOUNDARY
 * -------------
 * Everything here is a SUGGESTION for a person. This module cannot and
 * must not cause an action. There is no automated liking, following,
 * unfollowing, replying, warm-up, simulated browsing or engagement of any
 * kind anywhere in this milestone, and nothing in this file returns a
 * callable that performs one. A recommendation carries a rationale so
 * the operator can disagree with it.
 *
 * Recommendations are also allowed to say "do nothing", and frequently
 * should. With one follower and a 63-day silence, "publish another
 * announcement" is worse advice than "reply to the people who did engage".
 *
 * Pure module — no I/O.
 */

import type { AccountHealthPanel, HealthSignal, SignalKey } from "./account-health";

export type RecommendationKind =
  | "differentiate_copy"
  | "engage_manually"
  | "pause_publishing"
  | "resume_publishing"
  | "grow_audience_first"
  | "vary_content_mix"
  | "measure_first"
  | "no_action";

export type RecommendationUrgency = "now" | "soon" | "when_convenient" | "informational";

export interface Recommendation {
  kind: RecommendationKind;
  urgency: RecommendationUrgency;
  /** What the operator should do, in their own terms. */
  action: string;
  /** Why — always tied to a named signal, never to a hunch. */
  rationale: string;
  /** The signals that produced it, so the advice is traceable. */
  basedOn: SignalKey[];
  /**
   * Always false. Present as a structural guarantee: no consumer can
   * mistake a recommendation for something Signal will do itself.
   */
  automatable: false;
}

export function recommendNextActions(
  panel: AccountHealthPanel,
): Recommendation[] {
  const byKey = new Map<SignalKey, HealthSignal>(
    panel.signals.map((s) => [s.key, s]),
  );
  const out: Recommendation[] = [];

  const audience = byKey.get("audience");
  const inactivity = byKey.get("inactivity");
  const similarity = byKey.get("cross_platform_similarity");
  const promotional = byKey.get("promotional_pressure");
  const performance = byKey.get("recent_performance");
  const freshness = byKey.get("data_freshness");

  // 1. Measurement first. Advice built on unmeasured posts is guesswork.
  if (performance?.state === "insufficient_data" && freshness?.state === "unavailable") {
    out.push({
      kind: "measure_first",
      urgency: "now",
      action:
        "Run the metrics backfill for this account before acting on anything else on this panel.",
      rationale:
        "No post on this account has been measured, so every performance signal here is empty. " +
        "Backfilling is read-only and, on Bluesky, free.",
      basedOn: ["recent_performance", "data_freshness"],
      automatable: false,
    });
  }

  // 2. Audience before performance. This is the honest headline for the
  //    real account: one follower explains near-zero engagement entirely.
  if (audience?.state === "advisory") {
    out.push({
      kind: "grow_audience_first",
      urgency: "soon",
      action:
        "Treat audience growth as the goal for now, and do not read post-level performance as a verdict on the content.",
      rationale: audience.evidence,
      basedOn: ["audience"],
      automatable: false,
    });
  }

  // 3. The measurable content problem.
  if (similarity?.state === "advisory") {
    out.push({
      kind: "differentiate_copy",
      urgency: "soon",
      action:
        "Rewrite one of the two near-identical posts so each platform gets its own phrasing, and stagger the publish times.",
      rationale: similarity.evidence,
      basedOn: ["cross_platform_similarity"],
      automatable: false,
    });
  }

  // 4. Inactivity vs over-posting. The real data shows the former.
  if (inactivity?.state === "advisory") {
    out.push({
      kind: "resume_publishing",
      urgency: "when_convenient",
      action:
        "Publish something, or reply to an existing conversation, to end the gap before reading performance figures.",
      rationale: inactivity.evidence,
      basedOn: ["inactivity"],
      automatable: false,
    });
  }

  if (promotional?.state === "advisory") {
    out.push({
      kind: "vary_content_mix",
      urgency: "when_convenient",
      action:
        "Make the next post something other than a product or launch note — a question, an observation, or a reply to someone else.",
      rationale: promotional.evidence,
      basedOn: ["promotional_pressure"],
      automatable: false,
    });
  }

  // 5. The engagement recommendation, which is always a human action.
  if (audience?.state === "advisory" || inactivity?.state === "advisory") {
    out.push({
      kind: "engage_manually",
      urgency: "when_convenient",
      action:
        "Reply to people in your own timeline rather than publishing another post today. Signal will not do this for you.",
      rationale:
        "Conversation is how a small account acquires an audience, and it is not something " +
        "software should do on your behalf. Signal can draft a reply for you to review, but " +
        "sending is yours.",
      basedOn: ["audience", "inactivity"],
      automatable: false,
    });
  }

  if (out.length === 0) {
    out.push({
      kind: "no_action",
      urgency: "informational",
      action: "No change recommended.",
      rationale: panel.summary,
      basedOn: [],
      automatable: false,
    });
  }

  return out.sort(byUrgency);
}

const URGENCY_RANK: Record<RecommendationUrgency, number> = {
  now: 0,
  soon: 1,
  when_convenient: 2,
  informational: 3,
};

function byUrgency(a: Recommendation, b: Recommendation): number {
  return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.kind.localeCompare(b.kind);
}

/**
 * Actions this product will never take by itself. Exported so the
 * invariant test can assert none of them appears as a capability, and so
 * the boundary is written down somewhere a reader will find it.
 */
export const NEVER_AUTOMATED = [
  "liking posts",
  "following or unfollowing accounts",
  "sending replies",
  "sending mentions or direct messages",
  "simulated browsing or fake activity",
  "randomised delays intended to look human",
  "account warm-up routines",
] as const;
