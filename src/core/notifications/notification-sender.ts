import "server-only";
/**
 * Phase C2.2 / C2.3 — vendor-neutral notification sender abstraction.
 *
 * There is no email provider in this codebase, so the email sender is a
 * NO-OP stub that reports "not configured" (the digest content is still
 * built + previewable — see buildOperationalDigest). The Telegram
 * sender REUSES the existing publishing bot infra (readTelegramCredentials
 * + the documented sendMessage endpoint) to deliver a digest to an
 * operator-configured chat — it adds NO new publishing behavior. Both
 * implementations share one interface so a real email provider can be
 * dropped in later without touching callers.
 */

import { readTelegramCredentials } from "@/core/publishing/platform-credentials";
import { fetchWithTimeout, isTimeoutError } from "@/core/publishing/fetch-with-timeout";

export type SendChannel = "email" | "telegram";

export interface SendResult {
  ok: boolean;
  channel: SendChannel;
  detail: string;
}

export interface NotificationSender {
  channel: SendChannel;
  send(text: string): Promise<SendResult>;
}

/** Email sender — placeholder until an email provider is configured. */
export function createEmailSender(): NotificationSender {
  return {
    channel: "email",
    async send() {
      return {
        ok: false,
        channel: "email",
        detail: "No email provider is configured. Email digests are not sent yet.",
      };
    },
  };
}

/**
 * Telegram digest sender. Uses the existing bot token; the destination
 * chat id comes from TELEGRAM_DIGEST_CHAT_ID (operator-configured) — we
 * never reuse a publishing channel's chat id implicitly.
 */
export function createTelegramSender(chatId?: string | null): NotificationSender {
  return {
    channel: "telegram",
    async send(text: string): Promise<SendResult> {
      const creds = readTelegramCredentials();
      const target = chatId?.trim() || process.env.TELEGRAM_DIGEST_CHAT_ID?.trim() || "";
      if (!creds) {
        return { ok: false, channel: "telegram", detail: "TELEGRAM_BOT_TOKEN is not configured." };
      }
      if (!target) {
        return {
          ok: false,
          channel: "telegram",
          detail: "No Telegram digest chat configured (set TELEGRAM_DIGEST_CHAT_ID).",
        };
      }
      try {
        const resp = await fetchWithTimeout(
          `https://api.telegram.org/bot${creds.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: target, text, disable_web_page_preview: true }),
            timeoutMs: 15_000,
          },
        );
        if (!resp.ok) {
          return { ok: false, channel: "telegram", detail: `Telegram returned ${resp.status}.` };
        }
        return { ok: true, channel: "telegram", detail: "Digest sent to Telegram." };
      } catch (err) {
        if (isTimeoutError(err)) {
          return { ok: false, channel: "telegram", detail: "Telegram send timed out." };
        }
        return {
          ok: false,
          channel: "telegram",
          detail: err instanceof Error ? err.message : "Telegram send failed.",
        };
      }
    },
  };
}
