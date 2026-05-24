/**
 * Cross-platform anti-copypaste detectors.
 *
 * When the operator fans out one canonical idea to multiple
 * platforms, each output must be materially different — different
 * opening hook, different CTA, different structure. This module
 * provides pure detection; the adapter feeds findings into qaDraft.
 *
 * Three checks:
 *   1. Opening-hook similarity (Jaccard on tokenized words).
 *   2. Identical CTA across platforms.
 *   3. Structurally identical body (paragraph-count + first 80 chars
 *      of each paragraph match).
 *
 * No I/O. Pure functions only.
 */

import type { QaFinding } from "@/core/publishing-qa/types";
import type { PlatformNativeDraft } from "./types";

const HOOK_SIMILARITY_THRESHOLD = 0.6;

// =====================================================================
// Tokenization + Jaccard
// =====================================================================

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// =====================================================================
// Structural rhythm fingerprint
// =====================================================================

function paragraphRhythm(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim().slice(0, 80))
    .filter((p) => p.length > 0)
    .join("‖");
}

// =====================================================================
// Detector
// =====================================================================

/**
 * Compare a candidate draft against its siblings (same canonical
 * idea, other platforms). Returns QaFindings with the
 * cross_platform_copypaste category — the qa-draft orchestrator
 * merges them into the verdict.
 */
export function detectCrossPlatformCopypaste(input: {
  candidate: PlatformNativeDraft;
  siblings: ReadonlyArray<PlatformNativeDraft>;
}): ReadonlyArray<QaFinding> {
  const findings: QaFinding[] = [];
  const candHook = tokenize(input.candidate.hook);
  const candRhythm = paragraphRhythm(input.candidate.body);

  for (const sibling of input.siblings) {
    if (sibling.platform === input.candidate.platform) continue;

    // Hook similarity
    const sibHook = tokenize(sibling.hook);
    const sim = jaccard(candHook, sibHook);
    if (sim >= HOOK_SIMILARITY_THRESHOLD) {
      findings.push({
        category: "cross_platform_copypaste",
        severity: "warn",
        code: "shared_hook",
        message: `Opening hook on ${input.candidate.platform} is ${Math.round(sim * 100)}% similar to the ${sibling.platform} draft. Rewrite the opener so it reads native here.`,
        evidence: sibling.hook,
      });
    }

    // Identical CTA
    const candCta = (input.candidate.cta ?? "").trim().toLowerCase();
    const sibCta = (sibling.cta ?? "").trim().toLowerCase();
    if (candCta.length > 0 && candCta === sibCta) {
      findings.push({
        category: "cross_platform_copypaste",
        severity: "warn",
        code: "shared_cta",
        message: `CTA on ${input.candidate.platform} is identical to the ${sibling.platform} draft. Each platform needs its own CTA shape.`,
        evidence: sibling.cta ?? "",
      });
    }

    // Structural rhythm
    if (candRhythm.length > 0 && candRhythm === paragraphRhythm(sibling.body)) {
      findings.push({
        category: "cross_platform_copypaste",
        severity: "warn",
        code: "shared_structure",
        message: `Paragraph rhythm on ${input.candidate.platform} matches the ${sibling.platform} draft. Adapt the structure to platform-native expectations.`,
      });
    }
  }

  return findings;
}

// Export tokenize + jaccard so tests can build expectations without
// re-implementing the math.
export const __internal = { tokenize, jaccard, paragraphRhythm };
