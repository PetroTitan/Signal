/**
 * Phase F6.3 — pure text utilities for adapter preview rendering.
 *
 * Strictly platform-agnostic. Adapters that need to render a
 * markdown body into provider-shaped plain text MAY call these;
 * platform-specific opinions (X hashtag policy, Instagram caption
 * trimming, etc.) stay inside each adapter folder.
 *
 * No I/O. No randomness. No clock. Deterministic for a given input.
 */

/**
 * Markdown → plain text. Strips fenced code blocks, inline code,
 * bold/italic, links (keeps the visible label + URL), headings,
 * bullets, ordered list markers. Collapses runs of 3+ blank lines.
 *
 * Intended for adapters that publish to text-only surfaces (X,
 * Threads, Telegram, Reddit text posts, LinkedIn feed posts,
 * Instagram caption, YouTube description, Bluesky body). Adapters
 * that publish markdown verbatim (dev.to, Hashnode articles) DO NOT
 * call this.
 */
export function stripMarkdownToPlain(md: string): string {
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
 * Split text into chunks of at most `limit` characters. Splits on
 * paragraph boundaries first, then sentences, then words. Single
 * words longer than `limit` are hard-split as a last resort.
 *
 * Returns the original string as a single-element array when it
 * already fits.
 *
 * Adapters use this for explicit-thread rendering; auto-splitting
 * single-post intents is each adapter's own decision.
 */
export function splitIntoTextChunks(text: string, limit: number): string[] {
  if (limit <= 0) return [text];
  if (text.length <= limit) return [text.trim()];

  const out: string[] = [];
  let current = "";
  const paragraphs = text.split(/\n\n+/);

  function pushWord(w: string): void {
    if (current.length + w.length + 1 <= limit) {
      current = current ? `${current} ${w}` : w;
      return;
    }
    if (current) {
      out.push(current.trim());
      current = "";
    }
    if (w.length <= limit) {
      current = w;
      return;
    }
    for (let i = 0; i < w.length; i += limit) {
      out.push(w.slice(i, i + limit));
    }
  }

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
    for (const s of p.split(/(?<=[.!?])\s+/)) {
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
      for (const w of s.split(/\s+/)) pushWord(w);
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Count graphemes (approximately — uses Intl.Segmenter when
 * available, falls back to code-point count). Most provider budgets
 * are documented in graphemes; adapters that need a stricter count
 * call this rather than `.length` (which is UTF-16 code units).
 */
export function graphemeCount(text: string): number {
  // Intl.Segmenter is supported in Node ≥16 and all evergreen
  // browsers. The try/catch is defensive — never throw from a pure
  // helper.
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let n = 0;
    for (const _ of seg.segment(text)) n++;
    return n;
  } catch {
    return Array.from(text).length;
  }
}
