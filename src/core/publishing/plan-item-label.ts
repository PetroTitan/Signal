/**
 * Derived display label for a plan item.
 *
 * Once a titleless social post is a legitimate object (see
 * `requiresTitle` in `@/core/platform-native/approval-policy`), every
 * surface that used `item.title` as a row label, link text, or
 * accessible name needs something to render. The wrong fix is to make
 * the operator invent a title so a list row looks tidy — that is
 * exactly how a fake title ends up published.
 *
 * So the label is DERIVED, at render time, and never persisted.
 *
 * DISPLAY-ONLY — READ THIS BEFORE REUSING
 * ---------------------------------------
 * The value this module returns must never reach:
 *   - `weekly_plan_items.title` / `execution_items.title`
 *   - any `PublishRequest.title`
 *   - any adapter, transformer, or publisher input
 *
 * That is enforced structurally rather than by convention: this
 * module is imported only by presentational code, and
 * `title-contract.test.ts` asserts that no file under
 * `src/core/publishing/publish-*.ts`, `src/core/publishing/
 * transformers/`, `src/core/platform-native/adapters/`, or the
 * scheduler imports it.
 *
 * The publishing side is also safe by construction: the three
 * publishers that need a title refuse without a real one
 * (`missing_title` / `article_title_required` /
 * `hashnode_title_required`), and the titleless publishers never read
 * `request.title` at all — `transformers/x.ts` and
 * `transformers/bluesky.ts` document that the title is deliberately
 * NOT prepended to the body, and `transformers/telegram.ts` reads only
 * `bodyMarkdown`. There is no code path where a derived label could
 * become published text.
 *
 * Pure. No I/O. Safe on both server and client.
 */

/** Longest derived label before ellipsis. Roughly one line on a
 *  360px phone at the card's text size. */
const MAX_LABEL_LENGTH = 72;

export interface PlanItemLabelInput {
  title: string | null | undefined;
  body: string | null | undefined;
  /** Friendly platform label ("Bluesky"), not the raw slug. */
  platformLabel?: string | null;
}

/**
 * Reduce a markdown body to its first meaningful line of prose.
 *
 * Skips fenced code, headings' hash markers, list bullets, block
 * quotes, and images so the label reads like the post rather than
 * like its syntax. Returns an empty string when nothing usable is
 * left.
 */
export function firstMeaningfulBodyFragment(
  body: string | null | undefined,
): string {
  if (!body) return "";
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0) continue;
    // Strip leading markdown syntax rather than skipping the line —
    // "# Shipped the retry firewall" is a perfectly good label.
    const cleaned = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
    // A horizontal rule or an image-only line reduces to nothing.
    if (cleaned.length === 0) continue;
    if (/^[-*_]{3,}$/.test(cleaned)) continue;
    return cleaned;
  }
  return "";
}

function truncate(value: string): string {
  if (value.length <= MAX_LABEL_LENGTH) return value;
  return `${value.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

/**
 * The label a list row / card / link should render for this item.
 *
 * Precedence:
 *   1. A real operator-written title.
 *   2. The first meaningful fragment of the body — what the post
 *      actually opens with, which is what the operator recognises.
 *   3. The platform name, for an item that has a destination but no
 *      content yet ("Bluesky post").
 *   4. "Untitled post".
 */
export function planItemDisplayLabel(input: PlanItemLabelInput): string {
  const title = (input.title ?? "").trim();
  if (title.length > 0) return title;

  const fragment = firstMeaningfulBodyFragment(input.body);
  if (fragment.length > 0) return truncate(fragment);

  const platformLabel = (input.platformLabel ?? "").trim();
  if (platformLabel.length > 0) return `${platformLabel} post`;

  return "Untitled post";
}

/**
 * True when the rendered label was derived rather than written by the
 * operator. Surfaces let this drive a subdued style so the operator
 * can tell at a glance that they never typed a title — without being
 * nagged to invent one.
 */
export function isDerivedLabel(input: PlanItemLabelInput): boolean {
  return (input.title ?? "").trim().length === 0;
}
