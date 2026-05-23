/**
 * Phase F5.1 — Threads manual distribution transformer.
 *
 * Threads sits between Bluesky (short, conversational) and Twitter/X
 * (thread-shaped, sharper). Signal targets a 400-character soft
 * limit and a 500-character hard limit (Threads' documented ceiling
 * is 500). The post is plain text — no markdown, no hashtag spam,
 * at most one external URL.
 *
 * Threads exposes NO documented intent URL that pre-fills a post,
 * so the founder pastes the body manually into the Threads composer.
 */

import type { CanonicalPost } from "../canonical-post";

const SOFT_LIMIT = 400;
const HARD_LIMIT = 500;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

export interface ThreadsPost {
  text: string;
  warnings: string[];
}

export function transformForThreads(post: CanonicalPost): ThreadsPost {
  const warnings: string[] = [];
  const plain = renderMarkdownAsPlain(post.bodyMarkdown ?? "").trim();
  if (plain.length === 0) {
    return { text: "", warnings: ["Empty body."] };
  }

  const { text: textWithSingleLink } = keepOnlyFirstUrl(plain);
  const stripped = stripHashtagSpam(textWithSingleLink);

  let final = stripped;
  if (final.length > HARD_LIMIT) {
    final = final.slice(0, HARD_LIMIT).trimEnd();
    warnings.push(
      `Body was trimmed to Threads' ${HARD_LIMIT}-character limit.`,
    );
  } else if (final.length > SOFT_LIMIT) {
    warnings.push(
      `Post is ${final.length} chars. Threads tolerates up to ${HARD_LIMIT}, but ${SOFT_LIMIT}-or-less reads better.`,
    );
  }

  return { text: final, warnings };
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

function keepOnlyFirstUrl(text: string): { text: string; url: string | null } {
  let firstUrl: string | null = null;
  const out = text.replace(URL_RE, (match) => {
    if (firstUrl === null) {
      firstUrl = match;
      return match;
    }
    return "";
  });
  return { text: out.replace(/\s{2,}/g, " ").trim(), url: firstUrl };
}

function stripHashtagSpam(text: string): string {
  return text.replace(/(?:^|\s)#([A-Za-z0-9_]+)/g, (full, word) => {
    const leading = full.startsWith(" ") || full.startsWith("\n") ? full[0] : "";
    return `${leading}${word}`;
  });
}

/**
 * Open Threads' composer. Meta hasn't documented a `text=` intent
 * parameter for Threads, so this just opens the feed compose dialog;
 * the founder pastes the body from the Copy button.
 */
export function buildThreadsComposerUrl(): string {
  return "https://www.threads.net/";
}
