/**
 * Platform-native content engine — typed surface.
 *
 * The shape lives separately from src/core/generation/* because it
 * describes a richer per-platform contract than the existing
 * GenerationDraft. Generation still happens through generate-draft.ts;
 * this module adapts the canonical idea into platform-specific
 * structure, creative direction, and prompt-shaping, then wraps the
 * generated body in a PlatformNativeDraft envelope.
 *
 * No I/O. No DB. No AI calls. Pure functions and pure data.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import type { QaFinding } from "@/core/publishing-qa/types";

// =====================================================================
// Creative direction — required on every PlatformNativeDraft
// =====================================================================

/**
 * The kinds of visual a platform-native draft can recommend. "none"
 * is reserved for the rare case where the platform/context clearly
 * supports text-only (e.g. a Bluesky reflection where adding a
 * visual would feel forced). Most platforms recommend something.
 */
export type MediaType =
  | "none"
  | "screenshot"
  | "diagram"
  | "chart"
  | "carousel"
  | "short_video"
  | "animation"
  | "thumbnail"
  | "screen_recording"
  | "hero_image"
  | "static_image";

/**
 * The creative direction Signal hands the operator alongside the
 * draft. Required on every PlatformNativeDraft — the user's
 * requirement is "a post is not complete if it is only text" on
 * platforms where visuals matter.
 *
 * - mediaRequired: operator MUST supply media before publishing
 *   (Instagram, YouTube) vs. SHOULD consider supplying it (most
 *   others) vs. text-only is fine (rare).
 * - mediaType: the kind of visual.
 * - mediaPromptOrBrief: the brief the operator follows when
 *   creating the visual. Always describes what the visual should
 *   communicate — never asserts a visual exists.
 * - mediaRiskNotes: what NOT to do (no fake screenshots, no
 *   generic stock, no fabricated metrics charts, etc.).
 */
export interface CreativeDirection {
  mediaRequired: boolean;
  mediaType: MediaType;
  mediaPromptOrBrief: string;
  mediaRiskNotes: ReadonlyArray<string>;
}

// =====================================================================
// PlatformNativeDraft — the envelope around a generated body
// =====================================================================

/**
 * Coarse format the platform expects. Drives length/structure
 * guidance and helps downstream transformers know whether to split,
 * carousel-ify, or leave-as-prose.
 */
export type PlatformNativeFormat =
  | "single_post" // X-style short post (single tweet, single Bluesky post)
  | "thread" // multi-part on X / Bluesky / Threads
  | "long_form_article" // dev.to / Hashnode
  | "carousel" // Instagram / LinkedIn document carousel
  | "channel_update" // Telegram
  | "video_description" // YouTube (title + description + chapters)
  | "caption" // Instagram caption supporting a visual
  | "discussion_post"; // Reddit / Indie Hackers

export type PlatformRiskLevel = "low" | "medium" | "high";

/**
 * The platform-native draft envelope. Generation produces body + cta;
 * the engine fills the rest from the style profile + identity
 * context. Every field is required so the UI never has to invent
 * defaults.
 */
export interface PlatformNativeDraft {
  platform: FounderPlatform;
  /**
   * Title — present for platforms that use one (Reddit, dev.to,
   * Hashnode, YouTube, Indie Hackers). null for X, Bluesky, Threads,
   * LinkedIn (LinkedIn's lead sentence acts as title), Instagram
   * (caption-only), Telegram (channel posts don't have a title field).
   */
  title: string | null;
  /** The opening line / first-sentence hook. */
  hook: string;
  /** Body proper. Markdown for long_form / discussion_post; plain for the rest. */
  body: string;
  /** Per-platform CTA. null when the style profile says no CTA. */
  cta: string | null;
  /** Coarse format the platform expects. */
  format: PlatformNativeFormat;
  /** Required creative direction. */
  creativeDirection: CreativeDirection;
  /** Overall draft risk level — feeds into QA + new-account caps. */
  riskLevel: PlatformRiskLevel;
  /** Operator-facing warnings (length, link count, account age, etc.). */
  warnings: ReadonlyArray<string>;
  /**
   * Why this draft differs from sibling drafts on other platforms.
   * Required so cross-platform fan-out doesn't silently produce
   * five copies of the same paragraph.
   */
  transformationNotes: ReadonlyArray<string>;
}

// =====================================================================
// PlatformStyleProfile — pure data, one per platform
// =====================================================================

export interface PlatformStyleProfile {
  platform: FounderPlatform;
  /** Lowercase, hyphenated identifier for the dominant tone. */
  tone: string;
  /** How information-dense the post should be ("high", "moderate", "sparse"). */
  density: "high" | "moderate" | "sparse";
  /** Rhythm guidance ("punchy short sentences", "slow reflective paragraphs"). */
  pacing: string;
  /** Structural skeleton ("hook + observation + soft close"). */
  structure: string;
  /** Per-platform CTA style guidance (the prompt builder injects this). */
  ctaStyle: string;
  /** Patterns that READ as native to this platform. */
  allowedPatterns: ReadonlyArray<string>;
  /** Patterns that ALWAYS feel wrong on this platform. */
  forbiddenPatterns: ReadonlyArray<string>;
  /** Link policy: at most N links, where, and when. */
  linkPolicy: string;
  /** Hashtag policy. */
  hashtagPolicy: string;
  /** Emoji policy. */
  emojiPolicy: string;
  /** Media policy (high-level — full direction lives on CreativeDirection). */
  mediaPolicy: string;
  /** Length guidance — characters or words, depending on platform norm. */
  maxLengthGuidance: string;
  /** Extra rules that kick in for new (warming) accounts. */
  newAccountSafetyNotes: ReadonlyArray<string>;
}

// =====================================================================
// Adapter input / output
// =====================================================================

export interface AdaptIdeaIdentity {
  /** Display name for the identity (used in hooks / context only). */
  displayName: string | null;
  /** Handle for context. */
  handle: string | null;
  /** Voice profile (free text). */
  voiceProfile: string | null;
  /** Account age in days — drives new-account safety. */
  ageDays: number;
  /** Lifecycle status — feeds into safety caps. */
  status:
    | "planned"
    | "warming"
    | "active"
    | "paused"
    | "setup_needed"
    | "awaiting_manual_creation"
    | "archived";
}

export interface AdaptIdeaProduct {
  name: string;
  domain: string | null;
  summary: string | null;
  category: string | null;
}

export interface AdaptIdeaInput {
  /** The canonical strategic idea, in the operator's words. */
  canonicalIdea: string;
  /** Identity context. */
  identity: AdaptIdeaIdentity;
  /** Target platform. */
  platform: FounderPlatform;
  /** Associated product (null when the identity has none). */
  product: AdaptIdeaProduct | null;
  /** Goal of the post (call-to-action shape). */
  goal: string | null;
  /** Optional link the operator wants to embed. */
  link: string | null;
  /** Optional source article being summarized. */
  sourceArticle: string | null;
  /** Optional launch / update / changelog context. */
  launchContext: string | null;
  /**
   * Sibling drafts (same canonical idea, other platforms) for
   * cross-platform copypaste detection. Optional — when omitted, the
   * adapter still produces a native draft scaffold without
   * differentiation findings.
   */
  siblingDrafts?: ReadonlyArray<PlatformNativeDraft>;
}

/**
 * Adapter output. The adapter is PURE — it does not call the LLM.
 *
 * It returns:
 *   - a `scaffold` PlatformNativeDraft with everything filled in
 *     except `hook` / `body` / `cta` (those are placeholders the
 *     caller replaces with generated content),
 *   - a `promptShape` string the caller passes to the existing
 *     prompt builder (replacing the platformShape() switch output),
 *   - `forbiddenPatterns` to inject as guardrails,
 *   - a `ctaInstruction` to inject into the prompt,
 *   - any `qaFindings` from cross-platform differentiation.
 *
 * The existing `generate-draft.ts` pipeline produces the body; the
 * caller then calls `finalizeAdaptation` to glue body+hook+cta onto
 * the scaffold and produce a complete PlatformNativeDraft.
 */
export interface AdaptIdeaResult {
  scaffold: PlatformNativeDraft;
  promptShape: string;
  forbiddenPatterns: ReadonlyArray<string>;
  ctaInstruction: string;
  creativeDirection: CreativeDirection;
  qaFindings: ReadonlyArray<QaFinding>;
}
