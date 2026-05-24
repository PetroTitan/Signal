/**
 * Ecosystem content graph — derivative rules.
 *
 * A canonical idea (long-form on Hashnode, an architecture write-up,
 * a product changelog) has legitimate platform-native derivatives.
 * This module makes those rules explicit so the operator and the
 * orchestrator share the same picture of "where else can this go
 * without becoming copy-paste spam."
 *
 * The map is keyed by the *source* platform; values list the
 * platforms a derivative is appropriate for, with a short note on
 * what the derivative should look like.
 *
 * This is data, not logic. The orchestrator uses it to suggest where
 * a draft *could* be republished after transformation; it does not
 * automate the transformation itself.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";

export interface DerivativeRule {
  /** Target platform a derivative can land on. */
  target: FounderPlatform;
  /** What shape the derivative should take. One short line. */
  shape: string;
}

/**
 * Keyed by source platform. Targets exclude the source itself.
 * Order is "shortest distance first" — the first entry is the most
 * natural derivative, the last is the most aggressive transform.
 */
export const DERIVATIVE_MAP: Record<FounderPlatform, ReadonlyArray<DerivativeRule>> = {
  hashnode: [
    { target: "devto", shape: "Tighter implementation article focused on one section." },
    { target: "linkedin", shape: "Industry summary written for senior engineers/buyers." },
    { target: "x", shape: "Single-thought observation pulled from the strongest paragraph." },
    { target: "bluesky", shape: "Slower, more reflective restatement of the core argument." },
    { target: "youtube", shape: "Long-form video outline using the same skeleton." },
  ],
  devto: [
    { target: "hashnode", shape: "Expand into the architecture rationale behind the implementation." },
    { target: "linkedin", shape: "Industry-flavored summary linking back to the article." },
    { target: "x", shape: "One concrete observation from the tutorial, link-free." },
    { target: "youtube", shape: "Screen-recorded walkthrough of the same example." },
  ],
  linkedin: [
    { target: "x", shape: "Sharpest observation compressed to a single post." },
    { target: "bluesky", shape: "Same observation, lowercase, more reflective." },
    { target: "telegram", shape: "Short pointer to the LinkedIn post in the channel." },
  ],
  x: [
    { target: "bluesky", shape: "Same observation, written as if X didn't exist." },
    { target: "threads", shape: "Same observation, with light human scene-setting." },
    { target: "telegram", shape: "Folded into the next changelog post if it's product-relevant." },
  ],
  bluesky: [
    { target: "x", shape: "Compressed to a single, tighter post." },
    { target: "threads", shape: "Same observation, slightly more personal framing." },
  ],
  threads: [
    { target: "x", shape: "Drop the personal framing; keep the observation." },
    { target: "bluesky", shape: "Slow it down; lowercase; add reflection." },
    { target: "indie_hackers", shape: "Expand into a short founder-update post." },
  ],
  reddit: [
    // Reddit posts are sub-native; derivatives need careful re-framing.
    { target: "indie_hackers", shape: "Reframe as a founder lesson; no cross-link to the thread." },
    { target: "telegram", shape: "Soft pointer to the discussion if it landed well." },
  ],
  indie_hackers: [
    { target: "linkedin", shape: "Same operator lesson, written for a professional audience." },
    { target: "threads", shape: "Shorter founder-flavored version." },
    { target: "x", shape: "Sharpest observation pulled out as a single post." },
    { target: "telegram", shape: "Folded into the next changelog post if it's product-relevant." },
  ],
  telegram: [
    // Telegram is the changelog source; everything else is a fuller
    // derivative.
    { target: "x", shape: "Single-line announcement from the changelog entry." },
    { target: "linkedin", shape: "Substantive update post if the change is product-newsworthy." },
    { target: "indie_hackers", shape: "Expanded build-update with context the channel doesn't carry." },
  ],
  instagram: [
    { target: "youtube", shape: "Same visual story, longer narration." },
    { target: "linkedin", shape: "Caption + image republished as a visual update." },
  ],
  youtube: [
    { target: "devto", shape: "Companion article covering the same example." },
    { target: "hashnode", shape: "Architecture-focused companion write-up." },
    { target: "linkedin", shape: "Video announcement with a calm summary." },
    { target: "x", shape: "Single observation pulled from the video's argument." },
    { target: "telegram", shape: "Channel link to the video with one line of context." },
  ],
};

export function derivativesFor(
  source: FounderPlatform,
): ReadonlyArray<DerivativeRule> {
  return DERIVATIVE_MAP[source] ?? [];
}

/**
 * Reverse lookup — "given that we already published on X, which
 * source platforms is this a legal derivative of?" Used by the
 * orchestrator to flag suspicious cross-platform copy-paste when the
 * derivative isn't in the allowed set.
 */
export function legalSourcesFor(
  target: FounderPlatform,
): ReadonlyArray<FounderPlatform> {
  const sources: FounderPlatform[] = [];
  for (const [source, rules] of Object.entries(DERIVATIVE_MAP) as Array<
    [FounderPlatform, ReadonlyArray<DerivativeRule>]
  >) {
    if (rules.some((r) => r.target === target)) sources.push(source);
  }
  return sources;
}
