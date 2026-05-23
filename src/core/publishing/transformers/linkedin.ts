/**
 * Phase F5.0 — LinkedIn body transformer.
 *
 * LinkedIn isn't an automated publishing target in Signal — the
 * founder copies the prepared text into LinkedIn's native composer.
 * This transformer just makes the text LinkedIn-shaped:
 *
 *   - strip markdown headings (LinkedIn renders them as literal '#')
 *   - convert markdown lists to plain bulleted lines
 *   - convert [text](url) to "text (url)" with a single space
 *   - tighten 3+ blank lines into 2 (LinkedIn collapses long gaps anyway)
 *   - cap soft word count at 1200 (LinkedIn truncates at ~1300 with
 *     a "see more" expand)
 *
 * Returned shape is a single body. No threading.
 */

import type { CanonicalPost } from "../canonical-post";

const SOFT_WORD_CAP = 1200;
/** LinkedIn's documented character limit on the share dialog. */
const HARD_CHAR_LIMIT = 3000;

export interface LinkedInPost {
  text: string;
  warnings: string[];
}

export function transformForLinkedIn(post: CanonicalPost): LinkedInPost {
  const warnings: string[] = [];
  const md = (post.bodyMarkdown ?? "").trim();
  if (md.length === 0) return { text: "", warnings: ["Empty body."] };

  let text = md
    // Headings → plain text on their own line (lose '#').
    .replace(/^#{1,6}\s+/gm, "")
    // Bold/italic → keep text only.
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    // Inline code → bare text.
    .replace(/`([^`]+)`/g, "$1")
    // Fenced code → drop entirely (LinkedIn doesn't render code).
    .replace(/```[\s\S]*?```/g, "")
    // Links: "text (url)".
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    // List markers: normalize to "• " bullets.
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/^\s*/, ""))
    // Collapse 3+ blank lines.
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const wordCount = countWords(text);
  if (wordCount > SOFT_WORD_CAP) {
    warnings.push(
      `Long post (${wordCount} words). LinkedIn truncates around the "see more" boundary — keep the most important sentence in the first paragraph.`,
    );
  }

  if (text.length > HARD_CHAR_LIMIT) {
    text = text.slice(0, HARD_CHAR_LIMIT).trimEnd();
    warnings.push(
      `Body was trimmed to LinkedIn's ${HARD_CHAR_LIMIT}-character limit.`,
    );
  }

  return { text, warnings };
}

function countWords(text: string): number {
  return text
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

/**
 * LinkedIn's official "share" intent. Note: LinkedIn's share-offsite
 * URL only accepts a `url` parameter — there is NO official way to
 * prefill body text from a URL. So this returns the founder's
 * profile share dialog, and the founder pastes the body manually
 * from the "Copy post" button.
 *
 * When the post is summarizing a public URL (post.canonicalUrl), we
 * pass that URL through so LinkedIn at least shows the link preview
 * card; the founder still pastes the body.
 */
export function buildLinkedInShareIntentUrl(canonicalUrl: string | null): string {
  if (canonicalUrl) {
    return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(canonicalUrl)}`;
  }
  // No canonical URL — open the feed compose dialog. The founder
  // pastes the text manually from the Copy button.
  return "https://www.linkedin.com/feed/?shareActive=true";
}
