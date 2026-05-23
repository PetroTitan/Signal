/**
 * Phase F4 — Bluesky transformer.
 *
 * Bluesky posts (app.bsky.feed.post records) have a hard 300-grapheme
 * limit. Long-form CanonicalPost bodies must be split into a thread
 * of posts. The transformer is deterministic — same input always
 * produces the same thread.
 *
 * Transformation rules:
 *   - title is NOT prepended to the thread (Bluesky is text-only;
 *     a title would just eat 300 chars). It's stored on the canonical
 *     post for SEO platforms only.
 *   - body markdown is rendered to plain text:
 *       - **bold** / *italic* / `code` / [text](url) collapse to their text
 *       - URLs inside the brackets stay as-is at the end of the text node
 *     Lossy but readable — Bluesky doesn't support markdown anyway.
 *   - threads split on paragraph boundaries first, then on sentence
 *     boundaries, then on word boundaries as a last resort.
 *   - each post is at most 300 graphemes (we approximate via .length
 *     since JavaScript's String.length is UTF-16 code units, not
 *     graphemes — for safety we use 290 as the threshold).
 *   - thread parts get " (1/N)" suffix only when N > 1.
 *
 * Reference: https://docs.bsky.app/docs/api/com-atproto-repo-create-record
 */

import type { CanonicalPost } from "../canonical-post";

const SOFT_LIMIT = 290;
const HARD_LIMIT = 300;

export interface BlueskyPost {
  text: string;
}

export function transformForBluesky(post: CanonicalPost): BlueskyPost[] {
  const plain = renderMarkdownAsPlain(post.bodyMarkdown ?? "").trim();
  if (plain.length === 0) return [];

  const chunks = splitIntoChunks(plain, SOFT_LIMIT);
  if (chunks.length === 1) {
    return [{ text: chunks[0] }];
  }

  const total = chunks.length;
  return chunks.map((text, idx) => {
    const suffix = ` (${idx + 1}/${total})`;
    // If the suffix would push us over, trim the chunk a bit more.
    const reservedLen = suffix.length;
    const trimmed =
      text.length + reservedLen > HARD_LIMIT
        ? text.slice(0, HARD_LIMIT - reservedLen).trimEnd()
        : text;
    return { text: `${trimmed}${suffix}` };
  });
}

function renderMarkdownAsPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "") // strip fenced code blocks entirely
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1") // italic
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2") // [text](url) -> "text url"
    .replace(/^#{1,6}\s+/gm, "") // headings -> text
    .replace(/^[-*+]\s+/gm, "• ") // bullets
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list markers
    .replace(/\n{3,}/g, "\n\n") // collapse long blank-line runs
    .trim();
}

/**
 * Split text into chunks no longer than `limit`. Splits on paragraph
 * boundaries first, then sentences, then words. Single words longer
 * than `limit` are split mid-word as a last resort.
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
    // Paragraph itself is too long — split on sentences.
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
      // Sentence itself is too long — split on words.
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
          // One word longer than the limit — hard split mid-word.
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
