/**
 * Phase C1.1 — invitation token + lifecycle helpers (pure).
 *
 * The plaintext token is handed to the invitee (via the accept link)
 * and NEVER stored; only its sha256 hash lives in
 * workspace_invitations.token_hash. Acceptance hashes the presented
 * token and matches the row, then the SECURITY DEFINER RPC verifies
 * status/expiry/email server-side. This module owns generation +
 * hashing + the pure acceptability check.
 */

import { createHash, randomBytes } from "node:crypto";

export interface GeneratedInviteToken {
  /** Url-safe plaintext token — goes in the accept link, never stored. */
  token: string;
  /** sha256(token) hex — the only value persisted. */
  tokenHash: string;
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateInviteToken(): GeneratedInviteToken {
  const token = randomBytes(24).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export const DEFAULT_INVITE_TTL_DAYS = 7;

export function inviteExpiry(now: Date, ttlDays = DEFAULT_INVITE_TTL_DAYS): string {
  return new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}

export type InvitationAcceptability =
  | { ok: true }
  | { ok: false; reason: "not_pending" | "expired"; detail: string };

/**
 * Pure acceptability check used by the UI to render state and by the
 * action as a pre-flight (the RPC re-verifies authoritatively).
 */
export function checkInvitationAcceptable(
  input: { status: string; expiresAt: string },
  now: Date,
): InvitationAcceptability {
  if (input.status !== "pending") {
    return {
      ok: false,
      reason: "not_pending",
      detail: `This invitation is ${input.status}.`,
    };
  }
  const exp = new Date(input.expiresAt).getTime();
  if (Number.isNaN(exp) || exp <= now.getTime()) {
    return {
      ok: false,
      reason: "expired",
      detail: "This invitation has expired. Ask the workspace owner to re-send it.",
    };
  }
  return { ok: true };
}

export function normalizeInviteEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}
