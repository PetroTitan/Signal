/**
 * Draft QA orchestrator.
 *
 * Composes existing publishing primitives + the new helpers in this
 * module into a single deterministic pass. The result is a structured
 * verdict (pass | warn | block) and a list of findings the caller
 * can render or surface in the UI.
 *
 * Pure: no I/O, no DB, no AI. The caller is responsible for
 * assembling `recentHistory` from publish_history / weekly_plan_items.
 *
 * Composition (in order):
 *   1. Generation safety rules — banned phrases, fabrication regexes.
 *   2. Content guardrails — aggressive CTA, launch language, fake
 *      certainty, startup clichés, AI voice, duplicate hook against
 *      the recent-history hooks, unsupported claims.
 *   3. New-account caps — link count, thread allowance, hashtag cap,
 *      launch-language allowance.
 *   4. Topic-platform affinity — discouraged → warn, forbidden → block.
 *   5. Near-duplicate scan — Jaccard on token shingles + hook prefix
 *      similarity.
 */

import { evaluateDraftSafety } from "@/core/generation/safety-rules";
import { scanText, guardrailLabels } from "@/core/content-intelligence/guardrails";
import { detectCrossPlatformCopypaste } from "@/core/platform-native";
import {
  getCreativeDirection,
  type PlatformNativeDraft,
} from "@/core/platform-native";
import { newAccountCaps } from "./new-account-mode";
import {
  NEAR_DUP_THRESHOLD,
  scanForNearDuplicates,
} from "./near-duplicate";
import { affinityFor, classifyTopic } from "./topic-matrix";
import type {
  QaFinding,
  QaInput,
  QaResult,
  QaSeverity,
  QaSiblingDraft,
} from "./types";

const HASHTAG_RE = /(?:^|\s)#[\p{L}\p{N}_]+/gu;
const URL_RE = /\bhttps?:\/\/\S+/gi;

function severityRank(s: QaSeverity): number {
  return s === "block" ? 3 : s === "warn" ? 2 : 1;
}

function toVerdict(findings: ReadonlyArray<QaFinding>): QaResult["verdict"] {
  let worst: QaSeverity = "info";
  for (const f of findings) {
    if (severityRank(f.severity) > severityRank(worst)) worst = f.severity;
  }
  return worst === "block" ? "block" : worst === "warn" ? "warn" : "pass";
}

export function qaDraft(input: QaInput): QaResult {
  const findings: QaFinding[] = [];
  const fullText = `${input.draft.hook}\n${input.draft.body}\n${input.draft.cta ?? ""}`;

  // ---- 1. Generation safety (banned phrases, fabrication) ----
  const safety = evaluateDraftSafety({
    title: input.draft.hook || null,
    body: input.draft.body,
  });
  for (const v of safety.violations) {
    findings.push({
      category: "safety",
      severity: "block",
      code: v.startsWith("Looks fabricated") ? "fabrication" : "banned_phrase",
      message: v,
    });
  }

  // ---- 2. Content guardrails ----
  const knownHooks = input.recentHistory.map((p) => p.hook);
  const guard = scanText({
    hook: input.draft.hook,
    body: input.draft.body,
    cta: input.draft.cta,
    knownHooks,
  });
  for (let i = 0; i < guard.flags.length; i++) {
    const flag = guard.flags[i];
    const note = guard.notes[i] ?? guardrailLabels[flag];
    // Most guardrail flags warn. Launch language + fake certainty +
    // duplicate hook are stronger and block (the existing risk engine
    // treats duplicate hooks as +25 and launch spam through banned
    // phrases; we mirror that here so the orchestrator can refuse
    // pre-publish, not just at risk scoring time).
    const severity: QaSeverity =
      flag === "duplicate_hook" || flag === "fake_certainty"
        ? "block"
        : "warn";
    findings.push({
      category: "guardrail",
      severity,
      code: flag,
      message: note,
    });
  }

  // ---- 3. New-account caps ----
  const caps = newAccountCaps(input.identity);
  if (caps.isNewAccount) {
    const hashtags = (fullText.match(HASHTAG_RE) ?? []).length;
    const inlineLinks = (fullText.match(URL_RE) ?? []).length;
    const effectiveLinks = Math.max(
      input.draft.outboundLinkCount,
      inlineLinks,
    );

    if (effectiveLinks > caps.maxOutboundLinksPerItem) {
      findings.push({
        category: "new_account",
        severity: "block",
        code: "warming_link_cap",
        message: `Account is warming (${caps.warmUpDaysRemaining}d remaining). At most ${caps.maxOutboundLinksPerItem} outbound link per post; this draft has ${effectiveLinks}.`,
      });
    }
    if (hashtags > caps.maxHashtagsPerItem) {
      findings.push({
        category: "new_account",
        severity: "warn",
        code: "warming_hashtag_cap",
        message: `Warming account: keep hashtags to at most ${caps.maxHashtagsPerItem} (this draft has ${hashtags}).`,
      });
    }
    if (input.draft.isThread && !caps.allowThreads) {
      findings.push({
        category: "new_account",
        severity: "block",
        code: "warming_no_threads",
        message: `Warming ${input.identity.platform} accounts shouldn't publish threads yet. Prefer single posts and replies.`,
      });
    }
  }

  // ---- 4. Topic-platform affinity ----
  const topic = input.topicKind ?? classifyTopic(fullText);
  const affinity = affinityFor(topic, input.identity.platform);
  if (affinity === "forbidden") {
    findings.push({
      category: "topic_fit",
      severity: "block",
      code: "topic_forbidden",
      message: `"${prettyTopic(topic)}" content doesn't belong on ${input.identity.platform}.`,
    });
  } else if (affinity === "discouraged") {
    findings.push({
      category: "topic_fit",
      severity: "warn",
      code: "topic_discouraged",
      message: `"${prettyTopic(topic)}" is off-platform for ${input.identity.platform}; consider transforming or moving.`,
    });
  } else if (affinity === "derivative") {
    findings.push({
      category: "topic_fit",
      severity: "info",
      code: "topic_derivative",
      message: `${input.identity.platform} accepts "${prettyTopic(topic)}" as a derivative; rewrite native to the platform before shipping.`,
    });
  }

  // ---- 4b. Cross-platform copypaste (sibling drafts) ----
  if (input.siblingDrafts && input.siblingDrafts.length > 0) {
    const candidate = projectSibling(input.identity.platform, input.draft);
    const siblings = input.siblingDrafts.map((s) => projectSibling(s.platform, s));
    const cpcFindings = detectCrossPlatformCopypaste({
      candidate,
      siblings,
    });
    for (const f of cpcFindings) findings.push(f);
  }

  // ---- 5. Near-duplicate scan ----
  const dupScan = scanForNearDuplicates({
    hook: input.draft.hook,
    body: input.draft.body,
    recentHistory: input.recentHistory,
  });
  if (dupScan.bestMatch) {
    const { score, post, bodySimilarity, hookSimilarity } = dupScan.bestMatch;
    const samePlatform = post.platform === input.identity.platform;
    // Near-dup on the SAME platform is a hard block — that's a
    // re-post. Cross-platform near-dup warns — the operator may have
    // legitimately rewritten for the target, but we want them to see
    // the similarity score.
    const severity: QaSeverity =
      score >= NEAR_DUP_THRESHOLD ? (samePlatform ? "block" : "warn") : "warn";
    findings.push({
      category: "duplicate",
      severity,
      code: samePlatform ? "near_duplicate_same_platform" : "near_duplicate_cross_platform",
      message:
        samePlatform
          ? `Near-duplicate of a recent ${post.platform} post (body sim ${pct(bodySimilarity)}, hook sim ${pct(hookSimilarity)}).`
          : `Reads similar to a recent ${post.platform} post (body sim ${pct(bodySimilarity)}, hook sim ${pct(hookSimilarity)}). Rewrite native to ${input.identity.platform}.`,
      evidence: truncate(post.body, 160),
    });
  }

  const verdict = toVerdict(findings);
  return {
    verdict,
    findings,
    blocks: findings.filter((f) => f.severity === "block"),
    warnings: findings.filter((f) => f.severity === "warn"),
    infos: findings.filter((f) => f.severity === "info"),
  };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function prettyTopic(t: string): string {
  return t.replace(/_/g, " ");
}

/**
 * Project a (platform, hook, body, cta) tuple into the shape
 * detectCrossPlatformCopypaste expects. The detector only reads
 * platform/hook/body/cta — we fill the rest with placeholders so
 * we don't force callers to construct full PlatformNativeDrafts
 * just to run sibling QA.
 */
function projectSibling(
  platform: QaSiblingDraft["platform"],
  source: { hook: string; body: string; cta: string | null },
): PlatformNativeDraft {
  return {
    platform,
    title: null,
    hook: source.hook,
    body: source.body,
    cta: source.cta,
    format: "single_post",
    creativeDirection: getCreativeDirection(platform),
    riskLevel: "low",
    warnings: [],
    transformationNotes: [],
  };
}
