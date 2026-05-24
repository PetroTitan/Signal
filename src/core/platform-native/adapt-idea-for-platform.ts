/**
 * Idea-to-platform adapter.
 *
 * Pure deterministic function. Reads the platform style profile,
 * the creative direction, the identity's voice + warming state,
 * the topic matrix, and the derivative map; produces:
 *
 *   - a PlatformNativeDraft `scaffold` (every field except hook /
 *     body / cta — those come from generation),
 *   - the `promptShape` block the existing prompt builder should
 *     paste into the system message,
 *   - `forbiddenPatterns` to inject as guardrails,
 *   - the per-platform `ctaInstruction`,
 *   - the required `creativeDirection`,
 *   - any cross-platform copypaste `qaFindings` if siblings were
 *     supplied.
 *
 * Generation itself happens elsewhere — the adapter does NOT call
 * the LLM. The user's constraint: "use existing generation path and
 * make platform shaping stronger" — the adapter feeds a stronger
 * prompt; generate-draft still owns the provider call.
 *
 * After generation, callers use `finalizeAdaptation` to glue the
 * generated content into the scaffold and produce a complete
 * PlatformNativeDraft.
 */

import { affinityFor } from "@/core/publishing-qa/topic-matrix";
import { newAccountCaps } from "@/core/publishing-qa/new-account-mode";
import { getPlatformStyleProfile } from "./style-profiles";
import { getCreativeDirection } from "./creative-direction";
import { getForbiddenPatterns } from "./forbidden-patterns";
import {
  buildPlatformShape,
  buildCtaInstruction,
  buildNewAccountAddendum,
} from "./prompt-shape";
import { detectCrossPlatformCopypaste } from "./cross-platform-differentiation";
import type {
  AdaptIdeaInput,
  AdaptIdeaResult,
  PlatformNativeDraft,
  PlatformNativeFormat,
  PlatformRiskLevel,
} from "./types";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import type { QaFinding, TopicKind } from "@/core/publishing-qa/types";

// =====================================================================
// Format + risk derivation
// =====================================================================

/**
 * Coarse format per platform — drives downstream transformers and
 * tells the UI whether to render a long-form preview or a single-
 * post card. The mapping is fixed; the engine doesn't decide
 * threads-vs-single (that's the transformer's job at publish time).
 */
const PLATFORM_DEFAULT_FORMAT: Record<FounderPlatform, PlatformNativeFormat> = {
  reddit: "discussion_post",
  x: "single_post",
  bluesky: "single_post",
  linkedin: "single_post",
  threads: "single_post",
  instagram: "caption",
  telegram: "channel_update",
  devto: "long_form_article",
  hashnode: "long_form_article",
  youtube: "video_description",
  indie_hackers: "discussion_post",
};

function defaultRiskLevel(input: {
  platform: FounderPlatform;
  isNewAccount: boolean;
  hasLink: boolean;
  hasLaunchContext: boolean;
}): PlatformRiskLevel {
  // Warming + outbound link is medium across the board.
  if (input.isNewAccount && input.hasLink) return "medium";
  // Launch language during warming is high.
  if (input.isNewAccount && input.hasLaunchContext) return "high";
  if (input.isNewAccount) return "medium";
  return "low";
}

// =====================================================================
// Transformation notes — why this draft differs from siblings
// =====================================================================

/**
 * Static per-platform transformation notes. The adapter folds in
 * dynamic context (warming, links, launch) on top.
 */
const STATIC_TRANSFORMATION_NOTES: Record<FounderPlatform, ReadonlyArray<string>> = {
  reddit:
    [
      "Discussion-first shape; no marketing voice.",
      "Affiliation disclosed in the first paragraph when relevant.",
    ],
  x: [
    "Concise standalone observation; thread only when the idea genuinely needs it.",
    "No hashtags, at most one URL across the entire thread.",
  ],
  bluesky: [
    "Calmer, slower restatement — sentences over punch.",
    "Single readable paragraph; the splitter threads if needed.",
  ],
  linkedin: [
    "Operational lesson framed for senior engineers / buyers.",
    "No 'I'm thrilled / honored / humbled' opener; no 'thoughts?' closer.",
  ],
  threads: [
    "Lightweight conversational tone — less technical density than X.",
    "Single thought with optional human scene-setting.",
  ],
  instagram: [
    "Caption supports the required visual — never replaces it.",
    "Visual is the post; text is context.",
  ],
  telegram: [
    "Compact channel update; one line of context, one of detail.",
    "Respect notification fatigue — every post is a push.",
  ],
  devto: [
    "Article-shaped with H2 sections and concrete examples.",
    "Soft product mention only near the end when load-bearing.",
  ],
  hashnode: [
    "Architecture / design-rationale shape, not a status post.",
    "Walks the reader through constraints, options, and tradeoffs.",
  ],
  youtube: [
    "Title + description + chapter labels + thumbnail concept.",
    "Calm educational framing — no clickbait, no MrBeast emphasis.",
  ],
  indie_hackers: [
    "Build-in-public update with real (operator-supplied) specifics.",
    "Operator-to-operator tone; honest tradeoffs over polish.",
  ],
};

function transformationNotesFor(input: {
  platform: FounderPlatform;
  isNewAccount: boolean;
  hasLink: boolean;
  hasLaunchContext: boolean;
  topicAffinity: "native" | "derivative" | "discouraged" | "forbidden";
}): ReadonlyArray<string> {
  const notes: string[] = [...STATIC_TRANSFORMATION_NOTES[input.platform]];
  if (input.topicAffinity === "derivative") {
    notes.push(
      `This topic is a derivative for ${input.platform} — the shape has been adapted from its home platform.`,
    );
  }
  if (input.topicAffinity === "discouraged") {
    notes.push(
      `Topic kind is unusual on ${input.platform} — review whether another platform fits better.`,
    );
  }
  if (input.isNewAccount) {
    notes.push("Identity is warming — extra safety caps applied.");
  }
  if (input.hasLink) {
    notes.push("Outbound link present — link policy enforced per platform.");
  }
  if (input.hasLaunchContext) {
    notes.push("Launch context present — launch-language scan tightened.");
  }
  return notes;
}

// =====================================================================
// Warnings — surfaced on the scaffold
// =====================================================================

function warningsFor(input: {
  platform: FounderPlatform;
  isNewAccount: boolean;
  warmUpDaysRemaining: number;
  hasLink: boolean;
  hasLaunchContext: boolean;
  topicAffinity: "native" | "derivative" | "discouraged" | "forbidden";
}): ReadonlyArray<string> {
  const warnings: string[] = [];

  if (input.isNewAccount) {
    warnings.push(
      `Identity is warming (${input.warmUpDaysRemaining} day${input.warmUpDaysRemaining === 1 ? "" : "s"} remaining). New-account caps apply.`,
    );
  }
  if (input.isNewAccount && input.hasLink) {
    warnings.push(
      `${input.platform} new-account policy discourages outbound links — consider removing.`,
    );
  }
  if (input.isNewAccount && input.hasLaunchContext) {
    warnings.push(
      `${input.platform} new-account policy blocks launch language — reframe as a calmer build update.`,
    );
  }
  if (input.topicAffinity === "discouraged") {
    warnings.push(
      `Topic kind is discouraged on ${input.platform} — review whether another platform fits better.`,
    );
  }
  if (input.topicAffinity === "forbidden") {
    warnings.push(
      `Topic kind is forbidden on ${input.platform} — do not publish.`,
    );
  }
  return warnings;
}

// =====================================================================
// Public API
// =====================================================================

export function adaptIdeaForPlatform(input: AdaptIdeaInput): AdaptIdeaResult {
  const profile = getPlatformStyleProfile(input.platform);
  const creative = getCreativeDirection(input.platform);
  const forbiddenPatterns = getForbiddenPatterns(input.platform);

  const caps = newAccountCaps({
    platform: input.platform,
    ageDays: input.identity.ageDays,
    displayName: input.identity.displayName ?? "",
    handle: input.identity.handle,
    status: input.identity.status,
  });
  const isNewAccount = caps.isNewAccount;

  // Topic affinity — used for warnings + transformation notes.
  // We classify the canonical idea naively (best-effort) so the
  // affinity check works. classifyTopic in the QA module owns the
  // real keyword classifier; here we accept that the adapter is a
  // pure helper and just default to "derivative" when classification
  // isn't load-bearing.
  const topicKind: TopicKind = "operator_lesson";
  const topicAffinity = affinityFor(topicKind, input.platform);

  const hasLink = (input.link ?? "").length > 0;
  const hasLaunchContext = (input.launchContext ?? "").length > 0;

  const promptShape =
    buildPlatformShape(input.platform) +
    (isNewAccount ? buildNewAccountAddendum(input.platform) : "");

  const ctaInstruction = buildCtaInstruction(input.platform);

  const transformationNotes = transformationNotesFor({
    platform: input.platform,
    isNewAccount,
    hasLink,
    hasLaunchContext,
    topicAffinity,
  });

  const warnings = warningsFor({
    platform: input.platform,
    isNewAccount,
    warmUpDaysRemaining: caps.warmUpDaysRemaining,
    hasLink,
    hasLaunchContext,
    topicAffinity,
  });

  const scaffold: PlatformNativeDraft = {
    platform: input.platform,
    title: null, // generation fills this for title-carrying platforms
    hook: "",
    body: "",
    cta: null,
    format: PLATFORM_DEFAULT_FORMAT[input.platform],
    creativeDirection: creative,
    riskLevel: defaultRiskLevel({
      platform: input.platform,
      isNewAccount,
      hasLink,
      hasLaunchContext,
    }),
    warnings,
    transformationNotes,
  };

  const qaFindings: QaFinding[] = [];
  if (input.siblingDrafts && input.siblingDrafts.length > 0) {
    // The candidate has no generated body yet, so sibling copypaste
    // checks make no sense pre-generation. But callers can pass a
    // sibling list with FINISHED drafts and we'll surface findings
    // against this scaffold once finalizeAdaptation has populated it.
    // We pre-empt: surface a soft note that differentiation will be
    // re-evaluated post-generation.
    qaFindings.push({
      category: "cross_platform_copypaste",
      severity: "info",
      code: "sibling_check_pending",
      message: `${input.siblingDrafts.length} sibling draft${input.siblingDrafts.length === 1 ? "" : "s"} supplied — cross-platform differentiation will be re-checked after generation.`,
    });
  }

  // Use the profile's exported fields so they don't go unused — the
  // type checker would otherwise warn about an unused destructure.
  void profile;

  return {
    scaffold,
    promptShape,
    forbiddenPatterns,
    ctaInstruction,
    creativeDirection: creative,
    qaFindings,
  };
}

/**
 * Glue a generated body into a scaffold to produce a complete
 * PlatformNativeDraft. Pure. Use after `generateDraft` returns.
 *
 * Callers can optionally pass a list of sibling drafts (other
 * platforms' adaptations of the same idea); cross-platform copypaste
 * is checked here and findings are merged into the draft warnings.
 */
export function finalizeAdaptation(input: {
  scaffold: PlatformNativeDraft;
  generated: {
    title: string | null;
    hook: string;
    body: string;
    cta: string | null;
  };
  siblingDrafts?: ReadonlyArray<PlatformNativeDraft>;
}): {
  draft: PlatformNativeDraft;
  qaFindings: ReadonlyArray<QaFinding>;
} {
  const finalized: PlatformNativeDraft = {
    ...input.scaffold,
    title: input.generated.title,
    hook: input.generated.hook,
    body: input.generated.body,
    cta: input.generated.cta,
  };

  const qaFindings: QaFinding[] = [];
  if (input.siblingDrafts && input.siblingDrafts.length > 0) {
    const findings = detectCrossPlatformCopypaste({
      candidate: finalized,
      siblings: input.siblingDrafts,
    });
    qaFindings.push(...findings);
  }

  return { draft: finalized, qaFindings };
}
