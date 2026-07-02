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

/**
 * `code` lets a delivery job distinguish a benign "no provider / no
 * target configured" skip from a real send failure (network/HTTP), so
 * a no-op email sender never marks a job failed.
 */
export type SendResultCode = "sent" | "not_configured" | "error";

export interface SendResult {
  ok: boolean;
  channel: SendChannel;
  code: SendResultCode;
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
        code: "not_configured",
        detail: "No email provider is configured. Email digests are not sent yet.",
      };
    },
  };
}

/**
 * Telegram digest sender. Uses the existing bot token; the destination
 * chat id MUST be passed explicitly by the caller.
 *
 * SAFETY (PR5): there is deliberately NO implicit fallback to a global
 * `TELEGRAM_DIGEST_CHAT_ID`. The scheduled digest job iterates recipients
 * across ALL workspaces, and a global fallback would deliver every
 * tenant's digest to one shared chat — a cross-workspace leak. Callers
 * that legitimately target a single operator-owned chat (e.g. the manual
 * "send me a test digest" action) must pass that chat id in explicitly,
 * making the destination auditable at the call site. When no chat id is
 * provided the sender is a `not_configured` no-op and sends nothing.
 * Per-recipient routing for the scheduled path is a follow-up migration
 * (add a verified chat id to notification_preferences).
 */
export function createTelegramSender(chatId?: string | null): NotificationSender {
  return {
    channel: "telegram",
    async send(text: string): Promise<SendResult> {
      const creds = readTelegramCredentials();
      const target = chatId?.trim() || "";
      if (!creds) {
        return {
          ok: false,
          channel: "telegram",
          code: "not_configured",
          detail: "TELEGRAM_BOT_TOKEN is not configured.",
        };
      }
      if (!target) {
        return {
          ok: false,
          channel: "telegram",
          code: "not_configured",
          detail:
            "No Telegram chat id provided for this recipient — digest not sent (per-recipient routing not configured).",
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
          return {
            ok: false,
            channel: "telegram",
            code: "error",
            detail: `Telegram returned ${resp.status}.`,
          };
        }
        return { ok: true, channel: "telegram", code: "sent", detail: "Digest sent to Telegram." };
      } catch (err) {
        if (isTimeoutError(err)) {
          return { ok: false, channel: "telegram", code: "error", detail: "Telegram send timed out." };
        }
        return {
          ok: false,
          channel: "telegram",
          code: "error",
          detail: err instanceof Error ? err.message : "Telegram send failed.",
        };
      }
    },
  };
}
