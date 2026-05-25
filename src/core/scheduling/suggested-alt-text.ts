/**
 * Deterministic alt-text suggestion. Pure function. No I/O, no AI.
 *
 * The compose sheet offers a "Use suggested alt text" button so the
 * operator gets a calm starting point that they can edit. It is
 * NEVER written automatically — the operator must click to apply.
 *
 * Suggestion strategy:
 *   - If the creative was uploaded by the operator we don't know what
 *     it depicts. Suggest a neutral placeholder that includes the
 *     draft title when available.
 *   - If the creative was generated and has a prompt, derive from
 *     the prompt's first clause (callers can pass it through).
 *   - Otherwise fall back to a generic, accessibility-respecting
 *     placeholder that prompts the operator to describe the image.
 *
 * Tone: literal, descriptive, no marketing language.
 */

export interface SuggestAltTextInput {
  /** Plan-item title, when available. Used to ground generic
   *  uploads in the post's subject. */
  title: string | null;
  /** Operator-visible name of the product the draft promotes, if
   *  any. Optional grounding hint. */
  productName: string | null;
  /** Creative source: "uploaded" | "manual_url" | "generated" |
   *  "wikimedia" | "stock" | "planned". */
  sourceType: string | null;
  /** When source_type === "generated", the prompt the operator gave
   *  the image generator. */
  prompt: string | null;
}

export function suggestAltTextFor(input: SuggestAltTextInput): string {
  const title = (input.title ?? "").trim();
  const product = (input.productName ?? "").trim();
  const prompt = (input.prompt ?? "").trim();
  const source = (input.sourceType ?? "").trim();

  // Generated images: extract a literal description from the prompt.
  if (source === "generated" && prompt.length > 0) {
    return describeFromPrompt(prompt);
  }

  // Manual URL / wikimedia: we don't know what it shows. Offer a
  // gentle placeholder anchored to the post subject.
  if (source === "manual_url" || source === "wikimedia") {
    if (title.length > 0) {
      return `Image illustrating: ${title}.`;
    }
    return "Image accompanying the post — describe what it shows.";
  }

  // Uploaded by operator. Anchor on product + title when we have them.
  if (product.length > 0 && title.length > 0) {
    return `${product} screenshot illustrating: ${title}.`;
  }
  if (product.length > 0) {
    return `${product} logo on a calm gradient background.`;
  }
  if (title.length > 0) {
    return `Image illustrating: ${title}.`;
  }
  return "Image accompanying the post — describe what it shows.";
}

function describeFromPrompt(prompt: string): string {
  // Take the first sentence or clause, cap to ~100 chars, end with a
  // period, prefix with "Generated image showing".
  const firstSentence = prompt.split(/[.!?]\s/)[0]?.trim() ?? prompt.trim();
  const trimmed = firstSentence.replace(/^["'`]|["'`]$/g, "").trim();
  const capped = trimmed.length > 100 ? trimmed.slice(0, 100) : trimmed;
  // Drop a leading "Clean ..." / "A ..." filler.
  const cleaned = capped.replace(/^(a|an|the|clean)\s+/i, "");
  return `Generated image showing ${cleaned}.`;
}
