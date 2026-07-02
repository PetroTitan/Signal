import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramSender } from "./notification-sender";

/**
 * PR5 — the Telegram sender must NEVER route to a global chat implicitly.
 * The scheduled digest runs across all workspaces, so an implicit
 * TELEGRAM_DIGEST_CHAT_ID fallback would leak every tenant's digest to
 * one shared chat. These tests pin that safety property.
 */

const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_DIGEST_CHAT_ID"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("createTelegramSender", () => {
  it("does NOT fall back to the global TELEGRAM_DIGEST_CHAT_ID when no chat id is passed", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_DIGEST_CHAT_ID = "-1001234567890"; // global chat present
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await createTelegramSender().send("digest text");

    expect(res.code).toBe("not_configured");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/no telegram chat id/i);
    // Critical: nothing was sent anywhere.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports not_configured when the bot token is missing", async () => {
    // No TELEGRAM_BOT_TOKEN set.
    const res = await createTelegramSender("-1001234567890").send("digest text");
    expect(res.code).toBe("not_configured");
    expect(res.detail).toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  it("reports not_configured for an empty/whitespace explicit chat id (no send)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await createTelegramSender("   ").send("digest text");
    expect(res.code).toBe("not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
