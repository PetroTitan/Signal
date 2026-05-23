/**
 * Phase F5.1 — Telegram message transformer.
 *
 * Telegram supports limited Markdown V1 / HTML in messages, but
 * Signal sends plain text in V1 to keep the surface predictable.
 * Channel posts via Bot API have a 4096-character limit per message.
 *
 * This transformer:
 *   - strips markdown to plain text
 *   - preserves line breaks (Telegram renders \n as line break)
 *   - keeps URLs verbatim (Telegram auto-link-previews them)
 *   - truncates at the 4096-char hard limit, appending a "(truncated)"
 *     marker so the founder knows the message was clipped
 *
 * URL preview behavior is controlled at publish time, not here.
 */

import type { CanonicalPost } from "../canonical-post";

const TELEGRAM_HARD_LIMIT = 4096;

export interface TelegramMessage {
  text: string;
  warnings: string[];
  truncated: boolean;
}

export function transformForTelegram(post: CanonicalPost): TelegramMessage {
  const warnings: string[] = [];
  const body = (post.bodyMarkdown ?? "").trim();
  if (body.length === 0) {
    return {
      text: "",
      warnings: ["Empty body."],
      truncated: false,
    };
  }

  // Markdown → plain text. Telegram tolerates many characters but
  // raw markdown looks broken in the feed.
  let text = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/^\s*/, ""))
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  let truncated = false;
  if (text.length > TELEGRAM_HARD_LIMIT) {
    text = `${text.slice(0, TELEGRAM_HARD_LIMIT - 20).trimEnd()}\n\n(truncated)`;
    truncated = true;
    warnings.push(
      `Message was trimmed to Telegram's ${TELEGRAM_HARD_LIMIT}-character limit.`,
    );
  }

  // If the founder set a canonical URL, append it on its own line —
  // Telegram will produce a link-preview card.
  if (post.canonicalUrl && !text.includes(post.canonicalUrl)) {
    const candidate = `${text}\n\n${post.canonicalUrl}`;
    if (candidate.length <= TELEGRAM_HARD_LIMIT) {
      text = candidate;
    }
  }

  return { text, warnings, truncated };
}
