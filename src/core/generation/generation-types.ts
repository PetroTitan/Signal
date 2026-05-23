/**
 * Phase F4.5 — generation types.
 *
 * Narrow types for identity-aware draft generation. Used by the
 * server action, the prompt builder, the safety rules, and the
 * (future) MCP tool. Deliberately not coupled to any specific LLM
 * provider — the provider sits behind generate-draft.ts and is the
 * only place that knows about HTTP shapes.
 */

import type { CanonicalPost } from "@/core/publishing/canonical-post";

export type GenerationTone =
  | "calm_technical"
  | "founder_builder"
  | "conversational"
  | "operational_lessons"
  | "honest_update";

export interface GenerationInput {
  /** weekly_plan_items.id of the destination plan; null = use current week's plan. */
  weeklyPlanId: string | null;
  /** Required — the identity providing voice + platform + product context. */
  identityId: string;
  /** Optional override of the identity's default platform. */
  platform: string | null;
  /** Optional override of the identity's default product association. */
  productId: string | null;
  /** Required — the idea / topic the founder wants drafted. */
  topic: string;
  /** Optional — what the founder wants the post to accomplish. */
  goal: string | null;
  /** Optional — call to action shape (free text). */
  cta: string | null;
  /** Optional — URL the founder is summarizing or responding to. */
  sourceUrl: string | null;
  /** Optional — short note on tone adjustment. */
  toneAdjustment: string | null;
  /** Optional — soft schedule preference: "tomorrow", "this week", etc. */
  schedulePreference: string | null;
}

export interface GenerationDraft {
  title: string | null;
  /** Markdown body. Caller is responsible for storing verbatim. */
  bodyMarkdown: string;
  /** Free-text summary (plain text). */
  summary: string | null;
  /** Lowercase, slug-safe; max 5; platform-specific limits enforced downstream. */
  tags: string[];
  /** Optional CTA snippet the AI suggested; the founder edits before publishing. */
  ctaSuggestion: string | null;
  /** Soft schedule string the founder can apply via a preset. */
  schedulePreference: string | null;
  /** Was an AI provider actually used to produce this draft? */
  generatedByProvider: boolean;
  /** Provider-specific notes / safety annotations. Never includes secrets. */
  safetyNotes: string[];
}

/** Subset of canonical-post used to seed the founder compose sheet. */
export interface GenerationDraftSeed {
  topic: string;
  goal: string | null;
  cta: string | null;
  sourceUrl: string | null;
  toneAdjustment: string | null;
  schedulePreference: string | null;
  voiceProfilePreview: string | null;
  platformLabel: string | null;
}

export interface GenerationResult {
  /** True when a real provider produced the draft body. */
  providerUsed: boolean;
  /** Founder-readable status line for the UI. */
  status:
    | "provider_generated"
    | "manual_seed_created"
    | "provider_unavailable"
    | "provider_refused";
  draft: GenerationDraft;
  /**
   * Optional similarity warning when the topic looks close to a
   * recently published post. Always advisory — never blocks.
   */
  similarityWarning: string | null;
}

/**
 * The shape we hand to the prompt builder. Composed from the
 * publishing-identity-context module + generation inputs.
 */
export interface GenerationPromptContext {
  identityDisplayName: string | null;
  identityHandle: string | null;
  platform: string;
  platformLabel: string;
  voiceProfile: string | null;
  product: {
    name: string;
    domain: string | null;
    summary: string | null;
    category: string | null;
  } | null;
  platformVoiceHint: string | null;
  recentTopics: string[];
  input: GenerationInput;
}

/** Used by callers that need to map the draft into a CanonicalPost. */
export function generationDraftToCanonicalPost(
  draft: GenerationDraft,
  context: GenerationPromptContext,
): Pick<
  CanonicalPost,
  "title" | "bodyMarkdown" | "summary" | "tags" | "linkUrl"
> {
  return {
    title: draft.title,
    bodyMarkdown: draft.bodyMarkdown,
    summary: draft.summary,
    tags: draft.tags,
    linkUrl: context.input.sourceUrl,
  };
}
