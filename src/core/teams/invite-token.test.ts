import { describe, expect, it } from "vitest";
import {
  checkInvitationAcceptable,
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  isValidEmail,
  normalizeInviteEmail,
} from "./invite-token";

const NOW = new Date("2026-06-16T12:00:00.000Z");

describe("invite token", () => {
  it("generates a url-safe token whose hash matches hashInviteToken", () => {
    const { token, tokenHash } = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokenHash).toBe(hashInviteToken(token));
    expect(tokenHash).toHaveLength(64); // sha256 hex
  });

  it("produces distinct tokens", () => {
    expect(generateInviteToken().token).not.toBe(generateInviteToken().token);
  });

  it("hash is stable + never equal to the plaintext (token not recoverable)", () => {
    expect(hashInviteToken("abc")).toBe(hashInviteToken("abc"));
    expect(hashInviteToken("abc")).not.toBe("abc");
  });
});

describe("inviteExpiry", () => {
  it("defaults to 7 days out", () => {
    expect(inviteExpiry(NOW)).toBe("2026-06-23T12:00:00.000Z");
  });
  it("respects a custom ttl", () => {
    expect(inviteExpiry(NOW, 1)).toBe("2026-06-17T12:00:00.000Z");
  });
});

describe("checkInvitationAcceptable", () => {
  it("accepts a pending, unexpired invite", () => {
    expect(
      checkInvitationAcceptable({ status: "pending", expiresAt: "2026-06-20T00:00:00Z" }, NOW),
    ).toEqual({ ok: true });
  });
  it("rejects a non-pending invite", () => {
    const r = checkInvitationAcceptable({ status: "revoked", expiresAt: "2026-06-20T00:00:00Z" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_pending");
  });
  it("rejects an expired invite", () => {
    const r = checkInvitationAcceptable({ status: "pending", expiresAt: "2026-06-10T00:00:00Z" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });
  it("treats an invalid expiry as expired (fail-safe)", () => {
    const r = checkInvitationAcceptable({ status: "pending", expiresAt: "nonsense" }, NOW);
    expect(r.ok).toBe(false);
  });
});

describe("email helpers", () => {
  it("normalizes case + whitespace", () => {
    expect(normalizeInviteEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
  });
  it("validates basic shape", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
});
