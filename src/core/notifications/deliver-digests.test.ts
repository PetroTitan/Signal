import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deliverDigests, type DigestDeps } from "./deliver-digests";
import type { DigestRecipientPreference } from "@/repositories/notification-preferences-repository";
import type { NotificationSender, SendResultCode } from "./notification-sender";
import type { NotificationType } from "@/lib/supabase/types";

function pref(over: Partial<DigestRecipientPreference> = {}): DigestRecipientPreference {
  return {
    workspaceId: "w1",
    userId: "u1",
    workspaceName: "Acme",
    emailEnabled: false,
    telegramEnabled: true,
    digestCadence: "daily",
    ...over,
  };
}

function sender(
  channel: "telegram" | "email",
  code: SendResultCode,
  onSend?: (text: string) => void,
): NotificationSender {
  return {
    channel,
    async send(text: string) {
      onSend?.(text);
      return { ok: code === "sent", channel, code, detail: `${channel}:${code}` };
    },
  };
}

const UNREAD_2: { byType: Partial<Record<NotificationType, number>>; total: number } = {
  byType: { publish_failed: 2 },
  total: 2,
};

describe("deliverDigests — cadence targeting", () => {
  const deps: DigestDeps = {
    listPreferences: async (cadence) =>
      cadence === "daily"
        ? [pref({ userId: "daily-user" })]
        : [pref({ userId: "weekly-user", digestCadence: "weekly" })],
    countUnreadByType: async () => UNREAD_2,
    makeTelegramSender: () => sender("telegram", "sent"),
    makeEmailSender: () => sender("email", "not_configured"),
  };

  it("daily run delivers only to daily recipients", async () => {
    const r = await deliverDigests("daily", deps);
    expect(r.processed).toBe(1);
    expect(r.results[0].userId).toBe("daily-user");
    expect(r.results[0].status).toBe("sent");
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(0);
  });

  it("weekly run delivers only to weekly recipients", async () => {
    const r = await deliverDigests("weekly", deps);
    expect(r.processed).toBe(1);
    expect(r.results[0].userId).toBe("weekly-user");
    expect(r.results[0].status).toBe("sent");
  });
});

describe("deliverDigests — channel gating", () => {
  it("skips recipients with all channels disabled", async () => {
    const deps: DigestDeps = {
      listPreferences: async () => [pref({ telegramEnabled: false, emailEnabled: false })],
      countUnreadByType: async () => UNREAD_2,
      makeTelegramSender: () => sender("telegram", "sent"),
      makeEmailSender: () => sender("email", "sent"),
    };
    const r = await deliverDigests("daily", deps);
    expect(r.results[0].status).toBe("skipped_channel_disabled");
    expect(r.results[0].channels).toHaveLength(0);
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("does not attempt Telegram when telegram is disabled", async () => {
    const tg = vi.fn(() => sender("telegram", "sent"));
    const deps: DigestDeps = {
      listPreferences: async () => [pref({ telegramEnabled: false, emailEnabled: true })],
      countUnreadByType: async () => UNREAD_2,
      makeTelegramSender: tg,
      makeEmailSender: () => sender("email", "not_configured"),
    };
    const r = await deliverDigests("daily", deps);
    expect(tg).not.toHaveBeenCalled();
    expect(r.results[0].channels.map((c) => c.channel)).toEqual(["email"]);
  });
});

describe("deliverDigests — sender outcomes", () => {
  it("a no-op email sender does not fail the job", async () => {
    const deps: DigestDeps = {
      listPreferences: async () => [pref({ telegramEnabled: false, emailEnabled: true })],
      countUnreadByType: async () => UNREAD_2,
      makeTelegramSender: () => sender("telegram", "sent"),
      makeEmailSender: () => sender("email", "not_configured"),
    };
    const r = await deliverDigests("daily", deps);
    expect(r.ok).toBe(true);
    expect(r.failed).toBe(0);
    expect(r.results[0].status).toBe("skipped_sender_not_configured");
    expect(r.results[0].channels[0].status).toBe("skipped_not_configured");
  });

  it("one failing recipient does not fail the whole job", async () => {
    const deps: DigestDeps = {
      listPreferences: async () => [pref({ userId: "good" }), pref({ userId: "bad" })],
      countUnreadByType: async (_w, u) => {
        if (u === "bad") throw new Error("boom");
        return UNREAD_2;
      },
      makeTelegramSender: () => sender("telegram", "sent"),
      makeEmailSender: () => sender("email", "not_configured"),
    };
    const r = await deliverDigests("daily", deps);
    expect(r.ok).toBe(true);
    expect(r.processed).toBe(2);
    expect(r.results.find((x) => x.userId === "good")?.status).toBe("sent");
    expect(r.results.find((x) => x.userId === "bad")?.status).toBe("failed");
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
  });
});

describe("deliverDigests — content + empties", () => {
  it("digest text contains only the real unread types provided", async () => {
    let captured = "";
    const deps: DigestDeps = {
      listPreferences: async () => [pref()],
      countUnreadByType: async () => ({
        byType: { publish_failed: 2, connection_expiring: 1 },
        total: 3,
      }),
      makeTelegramSender: () => sender("telegram", "sent", (t) => (captured = t)),
      makeEmailSender: () => sender("email", "not_configured"),
    };
    await deliverDigests("daily", deps);
    expect(captured).toMatch(/2 publish failed/);
    expect(captured).toMatch(/1 connection/);
    expect(captured).not.toMatch(/blocked|invitation|ownership/i);
    // No fabricated engagement metrics.
    expect(captured).not.toMatch(/impression|reach|engagement|views/i);
  });

  it("skips recipients with zero unread notifications (no send attempted)", async () => {
    const tg = vi.fn(() => sender("telegram", "sent"));
    const deps: DigestDeps = {
      listPreferences: async () => [pref()],
      countUnreadByType: async () => ({ byType: {}, total: 0 }),
      makeTelegramSender: tg,
      makeEmailSender: () => sender("email", "not_configured"),
    };
    const r = await deliverDigests("daily", deps);
    expect(r.results[0].status).toBe("skipped_empty");
    expect(tg).not.toHaveBeenCalled();
  });
});

describe("deliverDigests — does not mutate notification state", () => {
  it("re-running sees the same unread counts (no auto mark-read)", async () => {
    const reads: string[] = [];
    const deps: DigestDeps = {
      listPreferences: async () => [pref()],
      countUnreadByType: async (_w, u) => {
        reads.push(u);
        return UNREAD_2; // unchanged across runs — nothing was marked read
      },
      makeTelegramSender: () => sender("telegram", "sent"),
      makeEmailSender: () => sender("email", "not_configured"),
    };
    const first = await deliverDigests("daily", deps);
    const second = await deliverDigests("daily", deps);
    expect(first.results[0].unreadTotal).toBe(2);
    expect(second.results[0].unreadTotal).toBe(2);
    expect(reads).toEqual(["u1", "u1"]);
    // The deps surface is read + send only — there is no capability to
    // mutate notification status, by construction.
    expect("markRead" in deps).toBe(false);
    expect("markNotification" in deps).toBe(false);
  });
});

describe("deliverDigests — publishing scheduler / pipeline untouched", () => {
  it("delivery code never references the scheduler, execution items, or publish history", () => {
    const root = process.cwd();
    const src =
      readFileSync(
        path.join(root, "src/core/notifications/deliver-digests.ts"),
        "utf8",
      ) +
      readFileSync(
        path.join(root, "src/app/api/notifications/digest/route.ts"),
        "utf8",
      );
    expect(src).not.toMatch(/publishing-scheduler|tickOnce/);
    expect(src).not.toMatch(/execution-item-repository|execution_items/);
    expect(src).not.toMatch(/publish_history|publish-history-repository/);
    expect(src).not.toMatch(/platform-native\/adapters|runPublish/);
  });
});
