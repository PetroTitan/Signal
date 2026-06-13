import { describe, expect, it } from "vitest";
import {
  buildBlockedNotification,
  buildConnectionExpiringNotification,
  buildFailedNotification,
  buildInvitationAcceptedNotification,
  buildOperationalDigest,
  buildScheduledDigest,
  buildStaleClaimNotification,
  isConnectionExpiringSoon,
} from "./notification-builder";

describe("buildFailedNotification", () => {
  it("plain failure → publish_failed with a stable dedupe key", () => {
    const s = buildFailedNotification({ executionItemId: "ei-1", where: "r/x", retryExhausted: false });
    expect(s.type).toBe("publish_failed");
    expect(s.dedupeKey).toBe("publish_failed:ei-1");
    expect(s.entityId).toBe("ei-1");
  });
  it("exhausted failure → retry_exhausted with a distinct key", () => {
    const s = buildFailedNotification({ executionItemId: "ei-1", where: "bluesky", retryExhausted: true });
    expect(s.type).toBe("retry_exhausted");
    expect(s.dedupeKey).toBe("retry_exhausted:ei-1");
    expect(s.title).toMatch(/retries exhausted/i);
  });
});

describe("buildBlockedNotification", () => {
  it("humanizes the reason code", () => {
    const s = buildBlockedNotification({ executionItemId: "ei-2", title: "Launch", reasonCode: "creative_missing_alt_text" });
    expect(s.type).toBe("publish_blocked");
    expect(s.body).toBe("creative missing alt text");
    expect(s.dedupeKey).toBe("publish_blocked:ei-2");
  });
});

describe("buildStaleClaimNotification", () => {
  it("warns about possible double publish", () => {
    const s = buildStaleClaimNotification({ executionItemId: "ei-3", title: "Thread" });
    expect(s.type).toBe("stale_claim");
    expect(s.body).toMatch(/may already be live/i);
  });
});

describe("buildConnectionExpiringNotification", () => {
  it("day-buckets the dedupe key so re-sync within a day doesn't spam", () => {
    const s = buildConnectionExpiringNotification({
      connectionId: "c-1",
      platformLabel: "X",
      expiresAtIso: "2026-06-20T08:00:00Z",
    });
    expect(s.type).toBe("connection_expiring");
    expect(s.dedupeKey).toBe("connection_expiring:c-1:2026-06-20");
  });
});

describe("buildInvitationAcceptedNotification", () => {
  it("names the joiner and keys on the invitation", () => {
    const s = buildInvitationAcceptedNotification({ invitationId: "inv-1", email: "a@b.co" });
    expect(s.type).toBe("invitation_accepted");
    expect(s.title).toMatch(/a@b\.co/);
    expect(s.dedupeKey).toBe("invitation_accepted:inv-1");
  });
});

describe("buildOperationalDigest", () => {
  it("returns empty string when there is nothing to report", () => {
    expect(
      buildOperationalDigest({
        published: 0,
        failed: 0,
        blocked: 0,
        retrying: 0,
        staleClaims: 0,
        expiringConnections: 0,
      }),
    ).toBe("");
  });
  it("lists only the non-zero real counts (no fabricated engagement)", () => {
    const text = buildOperationalDigest(
      { published: 3, failed: 1, blocked: 0, retrying: 0, staleClaims: 0, expiringConnections: 2 },
      { workspaceName: "Acme", period: "daily" },
    );
    expect(text).toMatch(/Acme/);
    expect(text).toMatch(/3 published/);
    expect(text).toMatch(/1 failed/);
    expect(text).toMatch(/2 connection/);
    expect(text).not.toMatch(/blocked/);
    expect(text).not.toMatch(/impression|reach|engagement/i);
  });
});

describe("buildScheduledDigest", () => {
  it("returns empty string when there are no unread notifications", () => {
    expect(buildScheduledDigest({ unreadByType: {}, total: 0 })).toBe("");
    expect(buildScheduledDigest({ unreadByType: { publish_failed: 0 }, total: 0 })).toBe("");
  });

  it("summarizes only the real unread types, with the total in the header", () => {
    const text = buildScheduledDigest({
      unreadByType: { publish_failed: 2, connection_expiring: 1 },
      total: 3,
      workspaceName: "Acme",
      period: "daily",
    });
    expect(text).toMatch(/Acme/);
    expect(text).toMatch(/3 unread/);
    expect(text).toMatch(/daily/);
    expect(text).toMatch(/2 publish failed/);
    expect(text).toMatch(/1 connection/);
    // Types with no unread rows are omitted.
    expect(text).not.toMatch(/blocked|invitation|ownership/);
    // No fabricated engagement metrics, no AI prose.
    expect(text).not.toMatch(/impression|reach|engagement|estimated/i);
  });

  it("covers team-event types (invitation/ownership) when present", () => {
    const text = buildScheduledDigest({
      unreadByType: { invitation_received: 1, ownership_transferred: 1 },
      total: 2,
    });
    expect(text).toMatch(/1 invitation\(s\) received/);
    expect(text).toMatch(/ownership transferred/);
  });
});

describe("isConnectionExpiringSoon", () => {
  const now = new Date("2026-06-16T12:00:00Z");
  it("true within the window", () => {
    expect(isConnectionExpiringSoon({ expiresAtIso: "2026-06-18T12:00:00Z", warningDays: 3, now })).toBe(true);
  });
  it("false outside the window", () => {
    expect(isConnectionExpiringSoon({ expiresAtIso: "2026-06-25T12:00:00Z", warningDays: 3, now })).toBe(false);
  });
  it("true once already expired (still needs attention)", () => {
    expect(isConnectionExpiringSoon({ expiresAtIso: "2026-06-10T12:00:00Z", warningDays: 3, now })).toBe(true);
  });
  it("false when no expiry is known", () => {
    expect(isConnectionExpiringSoon({ expiresAtIso: null, warningDays: 3, now })).toBe(false);
  });
});
