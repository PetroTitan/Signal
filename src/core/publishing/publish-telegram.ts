import "server-only";
/**
 * Phase F5.1 — Telegram publisher.
 *
 * Telegram Bot API `sendMessage` is the only platform-side automation
 * Signal performs from a non-Reddit/non-tier-1 distribution platform.
 * It's safe because:
 *   - The bot can only post to channels the founder has EXPLICITLY
 *     added it to as admin.
 *   - No DMs, no groups the founder hasn't configured, no scraping,
 *     no joining channels, no engagement automation.
 *   - Signal only calls sendMessage. No edit, no delete, no inline
 *     query handling, no callback handling.
 *
 * Reference: https://core.telegram.org/bots/api#sendmessage
 *
 * Authentication: bot token in URL path; documented format.
 *
 * NEVER:
 *   - logs the bot token
 *   - retries automatically
 *   - sends to chat ids not configured by the founder
 */

import { fetchWithTimeout, isTimeoutError } from "./fetch-with-timeout";
import { publishFail, publishOk } from "./publishing-result";
import { canonicalPostFromRequest } from "./canonical-post";
import {
  transformForTelegram,
  transformForTelegramCaption,
} from "./transformers/telegram";
import type { PublishOutcome, PublishRequest } from "./publishing-types";

export interface PublishTelegramInput {
  request: PublishRequest;
  /** From readTelegramCredentials(); caller's responsibility. */
  botToken: string;
  /** Channel id or @channelname. Stored on growth_accounts.handle. */
  chatId: string;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: {
    message_id?: number;
    chat?: { id?: number; username?: string; type?: string };
    date?: number;
  };
  error_code?: number;
  description?: string;
}

function nonEmptyString(s: string | null | undefined): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Build the synthetic permalink for a Telegram channel message.
 * Public channels with a @username get a `t.me/<channel>/<message_id>`
 * URL. Private channels return null — they have no public permalink.
 */
function buildTelegramPermalink(
  chatUsername: string | undefined,
  messageId: number,
): string | null {
  if (!chatUsername || chatUsername.length === 0) return null;
  return `https://t.me/${chatUsername}/${messageId}`;
}

export async function publishToTelegram(
  input: PublishTelegramInput,
): Promise<PublishOutcome> {
  const { request, botToken, chatId } = input;

  if (!botToken || botToken.trim().length === 0) {
    return publishFail(
      "missing_api_key",
      "Telegram: set TELEGRAM_BOT_TOKEN before publishing.",
    );
  }
  if (!chatId || chatId.trim().length === 0) {
    return publishFail(
      "missing_identifier",
      "Telegram: this identity has no channel set. Add the channel @username or numeric chat id on the identity card.",
    );
  }
  if (!request.body || request.body.trim().length === 0) {
    return publishFail("missing_body", "Telegram posts need body text.");
  }

  const post = canonicalPostFromRequest(request);

  // Branch on attached creative. When the scheduler resolved an
  // approved creative with a fetchable URL, switch from sendMessage
  // to sendPhoto with the body as the caption. Telegram caption
  // limit is 1024 chars (vs 4096 for messages); the caption
  // transformer trims and marks the result.
  //
  // No silent downgrade: if a creative is attached and the API
  // refuses the photo (invalid URL, bad dimensions, etc.), we return
  // a clear platform_api_error rather than retry as sendMessage —
  // the operator approved the photo intentionally.
  const photoUrl =
    request.creative !== null && request.creative !== undefined
      ? request.creative.assetUrl ?? request.creative.sourceUrl ?? null
      : null;

  if (request.creative && nonEmptyString(photoUrl)) {
    const caption = transformForTelegramCaption(post);
    return await sendTelegramPhoto({
      botToken,
      chatId,
      photoUrl,
      caption: caption.text,
      captionTruncated: caption.truncated,
      creativeId: request.creative.id,
    });
  }

  const transformed = transformForTelegram(post);
  if (transformed.text.length === 0) {
    return publishFail("missing_body", "Telegram message body is empty.");
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: transformed.text,
        // V1 — plain text only. Markdown V1 has fragile escaping rules
        // and broken posts erode trust. Founders can edit on Telegram
        // itself if they want bold/italic.
        // parse_mode intentionally omitted.
        disable_web_page_preview: false,
        disable_notification: true,
      }),
      timeoutMs: 20_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return publishFail(
        "platform_api_error",
        "Telegram didn't respond in time (20s).",
      );
    }
    return publishFail(
      "platform_api_error",
      `Telegram network error: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    return publishFail(
      "platform_unauthorized",
      "Telegram rejected the request. The bot token may be invalid, or the bot isn't an admin of this channel.",
      { http_status: response.status },
    );
  }
  if (response.status === 429) {
    return publishFail(
      "platform_rate_limited",
      "Telegram asked us to slow down.",
      { http_status: 429 },
    );
  }

  let json: TelegramApiResponse;
  try {
    json = (await response.json()) as TelegramApiResponse;
  } catch {
    return publishFail(
      "platform_api_error",
      "Couldn't read Telegram's response.",
      { http_status: response.status },
    );
  }

  if (!json.ok) {
    // Telegram returns a structured error with description. We
    // forward a softened version so the founder isn't reading raw
    // Bot API output.
    const detail = json.description ?? "Telegram refused the message.";
    return publishFail("platform_api_error", `Telegram: ${detail}`, {
      http_status: response.status,
      telegram_error_code: json.error_code ?? null,
    });
  }

  const messageId = json.result?.message_id ?? null;
  const chatUsername = json.result?.chat?.username;
  if (!messageId) {
    return publishFail(
      "platform_api_error",
      "Telegram accepted the request but didn't return a message id.",
    );
  }
  const permalink = buildTelegramPermalink(chatUsername, messageId);

  return publishOk({
    externalId: String(messageId),
    externalUrl: permalink,
    metadata: {
      chat_id: chatId,
      chat_username: chatUsername ?? null,
      truncated: transformed.truncated,
      mode: "automated",
      telegram_endpoint: "sendMessage",
      media_mode: "text_only",
      media_url_present: false,
    },
  });
}

interface SendTelegramPhotoInput {
  botToken: string;
  chatId: string;
  photoUrl: string;
  caption: string;
  captionTruncated: boolean;
  creativeId: string;
}

async function sendTelegramPhoto(
  input: SendTelegramPhotoInput,
): Promise<PublishOutcome> {
  const { botToken, chatId, photoUrl, caption, captionTruncated, creativeId } =
    input;
  const url = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  // Telegram's sendPhoto accepts a `photo` URL — the platform fetches
  // it server-side. No multipart upload from Signal; the asset URL
  // resolves to a publicly readable Supabase Storage object today.
  const body: Record<string, unknown> = {
    chat_id: chatId,
    photo: photoUrl,
    disable_notification: true,
  };
  // Empty captions are valid on sendPhoto; omit the field entirely
  // rather than send an empty string.
  if (caption.length > 0) {
    body.caption = caption;
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      return publishFail(
        "platform_api_error",
        "Telegram didn't respond in time (30s).",
        {
          telegram_endpoint: "sendPhoto",
          creative_id: creativeId,
          media_mode: "telegram_photo",
        },
      );
    }
    return publishFail(
      "platform_api_error",
      `Telegram network error: ${err instanceof Error ? err.message : "unknown"}`,
      {
        telegram_endpoint: "sendPhoto",
        creative_id: creativeId,
        media_mode: "telegram_photo",
      },
    );
  }

  if (response.status === 401 || response.status === 403) {
    return publishFail(
      "platform_unauthorized",
      "Telegram rejected the photo. The bot token may be invalid, or the bot isn't an admin of this channel.",
      {
        http_status: response.status,
        telegram_endpoint: "sendPhoto",
        creative_id: creativeId,
        media_mode: "telegram_photo",
      },
    );
  }
  if (response.status === 429) {
    return publishFail(
      "platform_rate_limited",
      "Telegram asked us to slow down.",
      {
        http_status: 429,
        telegram_endpoint: "sendPhoto",
        creative_id: creativeId,
        media_mode: "telegram_photo",
      },
    );
  }

  let json: TelegramApiResponse;
  try {
    json = (await response.json()) as TelegramApiResponse;
  } catch {
    return publishFail(
      "platform_api_error",
      "Couldn't read Telegram's response.",
      {
        http_status: response.status,
        telegram_endpoint: "sendPhoto",
        creative_id: creativeId,
        media_mode: "telegram_photo",
      },
    );
  }

  if (!json.ok) {
    const detail = json.description ?? "Telegram refused the photo.";
    // No silent downgrade. The operator approved the photo; surfacing
    // the failure lets them fix the asset URL / re-upload rather than
    // discovering a text-only post in the channel.
    return publishFail("platform_api_error", `Telegram: ${detail}`, {
      http_status: response.status,
      telegram_error_code: json.error_code ?? null,
      telegram_endpoint: "sendPhoto",
      creative_id: creativeId,
      media_mode: "telegram_photo",
    });
  }

  const messageId = json.result?.message_id ?? null;
  const chatUsername = json.result?.chat?.username;
  if (!messageId) {
    return publishFail(
      "platform_api_error",
      "Telegram accepted the photo but didn't return a message id.",
      {
        telegram_endpoint: "sendPhoto",
        creative_id: creativeId,
        media_mode: "telegram_photo",
      },
    );
  }
  const permalink = buildTelegramPermalink(chatUsername, messageId);
  return publishOk({
    externalId: String(messageId),
    externalUrl: permalink,
    metadata: {
      chat_id: chatId,
      chat_username: chatUsername ?? null,
      mode: "automated_photo",
      telegram_endpoint: "sendPhoto",
      media_mode: "telegram_photo",
      media_url_present: true,
      creative_id: creativeId,
      caption_truncated: captionTruncated,
    },
  });
}
