/**
 * Bridge between the legacy GenerationDraft and the new
 * PlatformNativeDraft envelope. Pure helpers.
 *
 * The generation pipeline still routes one canonical idea through
 * one provider call. This module:
 *   1. Builds the AdaptIdeaInput from the identity context + the
 *      generation input.
 *   2. Calls `adaptIdeaForPlatform()` to produce the scaffold +
 *      shaping context.
 *   3. After the provider returns (or fails), extracts hook + body
 *      + cta from the generated text and calls `finalizeAdaptation()`
 *      to produce a complete PlatformNativeDraft.
 *
 * No I/O. No AI calls. No DB.
 */

import {
  adaptIdeaForPlatform,
  finalizeAdaptation,
  type AdaptIdeaInput,
  type PlatformNativeDraft,
} from "@/core/platform-native";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import type { PublishingIdentityContext } from "@/core/publishing/publishing-identity-context";
import type { GenerationDraft, GenerationInput } from "./generation-types";

// =====================================================================
// AdaptIdeaInput assembly
// =====================================================================

/**
 * Compose the AdaptIdeaInput from the same identity context the
 * existing pipeline already loads. The adapter is platform-typed —
 * if the runtime platform string is outside FounderPlatform (e.g.
 * an experimental platform an MCP caller might pass), the caller
 * should fall back to the legacy path instead of building an
 * envelope.
 */
export function buildAdaptIdeaInput(input: {
  identityContext: PublishingIdentityContext;
  platform: FounderPlatform;
  generation: GenerationInput;
  launchContext?: string | null;
}): AdaptIdeaInput {
  return {
    canonicalIdea: input.generation.topic,
    identity: {
      displayName: input.identityContext.displayName,
      handle: input.identityContext.handle,
      voiceProfile: input.identityContext.voiceProfile,
      ageDays: input.identityContext.ageDays,
      status: input.identityContext.lifecycleStatus,
    },
    platform: input.platform,
    product: input.identityContext.associatedProduct
      ? {
          name: input.identityContext.associatedProduct.name,
          domain: input.identityContext.associatedProduct.domain,
          summary: input.identityContext.associatedProduct.summary,
          category: input.identityContext.associatedProduct.category,
        }
      : null,
    goal: input.generation.goal,
    link: input.generation.sourceUrl,
    sourceArticle: input.generation.sourceUrl,
    launchContext: input.launchContext ?? null,
  };
}

// =====================================================================
// Body parsing — hook + cta extraction from generated markdown
// =====================================================================

/**
 * Pull the first non-empty markdown line as the hook. Skips H1
 * (used as title), code-fence delimiters, and content inside code
 * fences so the hook is the first prose sentence of the body.
 */
export function extractHook(bodyMarkdown: string): string {
  const lines = bodyMarkdown.split(/\r?\n/);
  let insideFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    return trimmed.replace(/^[*_>]+\s*/, "").slice(0, 280);
  }
  return "";
}

/**
 * Pull a likely CTA from the tail of a markdown body. Conservative:
 * we only return a string when the last paragraph reads as a CTA-
 * shaped sentence (ends with `?`, starts with a verb, or contains
 * "if you" / "let me know"). Otherwise null — the platform style
 * profile's ctaStyle has already told the model whether to write a
 * CTA, so the absence of a tail CTA is fine.
 */
export function extractCta(bodyMarkdown: string): string | null {
  const trimmed = bodyMarkdown.trim();
  if (trimmed.length === 0) return null;
  const paragraphs = trimmed.split(/\n\s*\n/);
  if (paragraphs.length === 0) return null;
  const last = paragraphs[paragraphs.length - 1].trim();
  if (last.length === 0 || last.length > 280) return null;
  const lower = last.toLowerCase();
  const looksLikeCta =
    last.endsWith("?") ||
    lower.startsWith("if you") ||
    lower.startsWith("let me know") ||
    lower.startsWith("curious") ||
    lower.startsWith("would love") ||
    lower.startsWith("we'd be glad") ||
    lower.includes("drop the ");
  return looksLikeCta ? last : null;
}

// =====================================================================
// Assembly — call adapter + glue generated body in
// =====================================================================

export interface AssembleResultInput {
  identityContext: PublishingIdentityContext;
  platform: FounderPlatform;
  generation: GenerationInput;
  /** The GenerationDraft already produced by the existing pipeline. */
  draft: GenerationDraft;
  /**
   * Optional sibling drafts (other platforms' adaptations of the
   * same canonical idea) for cross-platform copypaste detection
   * during finalize.
   */
  siblingDrafts?: ReadonlyArray<PlatformNativeDraft>;
}

/**
 * Build the complete PlatformNativeDraft from the identity context,
 * the generation inputs, and an already-produced GenerationDraft.
 * Pure. Always returns a complete envelope — never throws when the
 * body is empty (the seeded / failure paths produce minimal but
 * valid PlatformNativeDrafts so the operator still sees the
 * platform shape + creative direction).
 */
export function assemblePlatformNativeDraft(
  input: AssembleResultInput,
): PlatformNativeDraft {
  const adaptInput = buildAdaptIdeaInput({
    identityContext: input.identityContext,
    platform: input.platform,
    generation: input.generation,
  });
  const adapted = adaptIdeaForPlatform(adaptInput);

  const hook = extractHook(input.draft.bodyMarkdown);
  const cta = input.draft.ctaSuggestion ?? extractCta(input.draft.bodyMarkdown);

  const { draft: finalized } = finalizeAdaptation({
    scaffold: adapted.scaffold,
    generated: {
      title: input.draft.title,
      hook,
      body: input.draft.bodyMarkdown,
      cta,
    },
    siblingDrafts: input.siblingDrafts,
  });

  return finalized;
}
