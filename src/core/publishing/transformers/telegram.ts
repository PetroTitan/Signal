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
/**
 * Telegram caption limit on `sendPhoto` is 1024 characters. The text
 * transformer trims at TELEGRAM_HARD_LIMIT (4096); the caption
 * transformer trims at TELEGRAM_CAPTION_LIMIT.
 */
export const TELEGRAM_CAPTION_LIMIT = 1024;

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

/**
 * Transform a canonical post into a Telegram `sendPhoto` caption.
 *
 * Mirrors `transformForTelegram` (markdown → plain text, canonical-URL
 * tail) but trims at TELEGRAM_CAPTION_LIMIT (1024) instead of 4096.
 *
 * Long-caption policy (chosen as the safer minimal implementation):
 * truncate the caption at the 1024-char Telegram limit and append a
 * "(truncated)" marker so the founder sees the message was clipped.
 * `truncated: true` is also surfaced in publish_history metadata via
 * the adapter so observability records it explicitly. We do NOT split
 * into "photo + follow-up sendMessage" because:
 *
 *   1. Telegram channel posts cannot be rolled back if the second
 *      message fails (no atomic two-message API), so the split is
 *      strictly more fragile than truncation.
 *   2. The permalink would refer only to the photo message; the
 *      follow-up text would orbit with a separate id, complicating
 *      `execution_logs` / `publish_history` shape.
 *
 * Truncation is the platform's own recommended fallback for media
 * captions exceeding the limit (the API returns 400 otherwise).
 */
export function transformForTelegramCaption(
  post: CanonicalPost,
): TelegramMessage {
  const warnings: string[] = [];
  const body = (post.bodyMarkdown ?? "").trim();
  if (body.length === 0) {
    // Empty caption is valid on sendPhoto — adapter will omit the
    // caption field rather than send an empty string. Surface the
    // empty-body signal so the caller can log it.
    return { text: "", warnings: ["Empty body."], truncated: false };
  }

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
  if (text.length > TELEGRAM_CAPTION_LIMIT) {
    text = `${text.slice(0, TELEGRAM_CAPTION_LIMIT - 20).trimEnd()}\n\n(truncated)`;
    truncated = true;
    warnings.push(
      `Caption was trimmed to Telegram's ${TELEGRAM_CAPTION_LIMIT}-character photo-caption limit.`,
    );
  }

  // Append canonical URL if it fits — same rule as the text variant
  // but against the caption limit. If it doesn't fit, drop it; the
  // link-preview card from sendPhoto is owned by the photo itself.
  if (post.canonicalUrl && !text.includes(post.canonicalUrl)) {
    const candidate = `${text}\n\n${post.canonicalUrl}`;
    if (candidate.length <= TELEGRAM_CAPTION_LIMIT) {
      text = candidate;
    }
  }

  return { text, warnings, truncated };
}
