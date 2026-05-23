/**
 * Phase F5.0 — X (formerly Twitter) thread transformer.
 *
 * X posts have a 280-character hard limit (X Premium accounts can
 * go longer; we don't assume Premium). We target 260 chars per
 * thread part to leave headroom for trailing thread markers and
 * client-side overcounting of complex emoji.
 *
 * Transformation rules:
 *   - title is NOT prepended (X is text-only; a title would just
 *     eat budget)
 *   - body markdown is collapsed to plain text the same way Bluesky
 *     does — strip fences, code spans, bold/italic, headings, list
 *     markers, [text](url) becomes "text url"
 *   - at most one external URL is preserved across the entire
 *     thread; additional URLs are dropped silently (founder reviews
 *     the preview and can edit)
 *   - hashtags in the body are removed entirely (#word → word) —
 *     X hashtag spam is the #1 trigger of "this looks like a bot"
 *   - thread parts get " (1/N)" only when N > 1
 *
 * Distribution mode: this transformer prepares the thread for the
 * founder to paste into X's native composer. The publisher itself
 * is the founder's hand on the keyboard, not a Signal API call.
 */

import type { CanonicalPost } from "../canonical-post";

const SOFT_LIMIT = 260;
const HARD_LIMIT = 275; // leave 5 chars for thread suffix safety

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

export interface XPost {
  text: string;
}

export function transformForX(post: CanonicalPost): XPost[] {
  const plain = renderMarkdownAsPlain(post.bodyMarkdown ?? "").trim();
  if (plain.length === 0) return [];

  const { text: textWithSingleLink } = keepOnlyFirstUrl(plain);
  const stripped = stripHashtagSpam(textWithSingleLink);

  const chunks = splitIntoChunks(stripped, SOFT_LIMIT);
  if (chunks.length === 1) {
    return [{ text: clamp(chunks[0], HARD_LIMIT) }];
  }

  const total = chunks.length;
  return chunks.map((text, idx) => {
    const suffix = ` (${idx + 1}/${total})`;
    const reservedLen = suffix.length;
    const trimmed =
      text.length + reservedLen > HARD_LIMIT
        ? text.slice(0, HARD_LIMIT - reservedLen).trimEnd()
        : text;
    return { text: `${trimmed}${suffix}` };
  });
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd();
}

function renderMarkdownAsPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Preserve the FIRST URL the founder included. Drop everything
 * after. X threads tolerate one link; multiple links across the
 * thread look spammy and trip platform suspicion filters.
 */
function keepOnlyFirstUrl(text: string): { text: string; url: string | null } {
  let firstUrl: string | null = null;
  const out = text.replace(URL_RE, (match) => {
    if (firstUrl === null) {
      firstUrl = match;
      return match;
    }
    return ""; // drop subsequent URLs
  });
  return { text: out.replace(/\s{2,}/g, " ").trim(), url: firstUrl };
}

/**
 * Remove hashtags entirely (#word → word). Anything that looks like
 * #abc, #abc123, or #UPPER is stripped of its leading hash. We keep
 * the word itself because the founder may have written naturally
 * inflected prose like "the #SEO industry". Stripped form: "the SEO
 * industry" — preserves meaning, removes hashtag-spam signal.
 */
function stripHashtagSpam(text: string): string {
  return text.replace(/(?:^|\s)#([A-Za-z0-9_]+)/g, (full, word) => {
    const leading = full.startsWith(" ") || full.startsWith("\n") ? full[0] : "";
    return `${leading}${word}`;
  });
}

/**
 * Split text into chunks ≤ limit. Paragraph → sentence → word.
 * Mirrors the Bluesky splitter, with the X-specific 260 target.
 */
export function splitIntoChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text.trim()];
  const out: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";
  for (const p of paragraphs) {
    if (current.length + p.length + 2 <= limit) {
      current = current ? `${current}\n\n${p}` : p;
      continue;
    }
    if (current) {
      out.push(current.trim());
      current = "";
    }
    if (p.length <= limit) {
      current = p;
      continue;
    }
    const sentences = p.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (current.length + s.length + 1 <= limit) {
        current = current ? `${current} ${s}` : s;
        continue;
      }
      if (current) {
        out.push(current.trim());
        current = "";
      }
      if (s.length <= limit) {
        current = s;
        continue;
      }
      const words = s.split(/\s+/);
      for (const w of words) {
        if (current.length + w.length + 1 <= limit) {
          current = current ? `${current} ${w}` : w;
          continue;
        }
        if (current) {
          out.push(current.trim());
          current = "";
        }
        if (w.length <= limit) {
          current = w;
        } else {
          for (let i = 0; i < w.length; i += limit) {
            out.push(w.slice(i, i + limit));
          }
        }
      }
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Build the official "compose post" intent URL for X. The founder
 * clicks this link to open X's native composer with the thread's
 * FIRST post pre-filled. Subsequent thread parts are copied
 * manually — X's intent URL doesn't support threads in one shot.
 */
export function buildXShareIntentUrl(firstPostText: string): string {
  const params = new URLSearchParams({ text: firstPostText });
  return `https://x.com/intent/post?${params.toString()}`;
}

/**
 * Full plain-text dump of the thread, joined with the thread
 * separators the founder will paste into X. Used by the "Copy
 * everything" button.
 */
export function buildFullThreadText(thread: XPost[]): string {
  return thread.map((p) => p.text).join("\n\n---\n\n");
}
