/**
 * Phase F5.2 — token state derivation.
 *
 * Pure functions that map an OperatorToken into founder-readable
 * state strings. No I/O. Designed so the tokens list never
 * displays "Connected" without real evidence — see the brief's
 * "no fake verification" rule.
 *
 * State derivation logic:
 *   - Revoked / Expired statuses → terminal
 *   - Active + has last_used_at → "Connected" (the only honest
 *     positive signal we can derive purely from the token row)
 *   - Active + no last_used_at → "Awaiting first connection"
 *   - Active + last used > 60d ago → "Stale" warning (still active,
 *     surface a soft prompt to revoke if unused)
 *   - Active + expires_at in the past → "Expired" (DB status may
 *     not have updated yet, but we surface it correctly)
 */

import type { OperatorToken } from "@/repositories/mcp-server/operator-token-repository";

export type TokenState =
  | { kind: "connected"; lastUsedAt: string; staleDays: number | null }
  | { kind: "awaiting_first_connection" }
  | { kind: "stale"; lastUsedAt: string; staleDays: number }
  | { kind: "revoked"; revokedAt: string | null }
  | { kind: "expired"; expiresAt: string | null };

const STALE_DAYS_THRESHOLD = 60;

export function deriveTokenState(token: OperatorToken): TokenState {
  if (token.status === "revoked") {
    return { kind: "revoked", revokedAt: token.revokedAt };
  }
  if (token.status === "expired") {
    return { kind: "expired", expiresAt: token.expiresAt };
  }

  // Active beyond expiration: surface as expired even if the row's
  // status hasn't been swept yet.
  if (token.expiresAt) {
    const expiresMs = new Date(token.expiresAt).getTime();
    if (!Number.isNaN(expiresMs) && expiresMs <= Date.now()) {
      return { kind: "expired", expiresAt: token.expiresAt };
    }
  }

  if (!token.lastUsedAt) {
    return { kind: "awaiting_first_connection" };
  }

  const lastUsedMs = new Date(token.lastUsedAt).getTime();
  if (Number.isNaN(lastUsedMs)) {
    return { kind: "awaiting_first_connection" };
  }
  const daysSince = Math.floor(
    (Date.now() - lastUsedMs) / (24 * 60 * 60 * 1000),
  );
  if (daysSince >= STALE_DAYS_THRESHOLD) {
    return {
      kind: "stale",
      lastUsedAt: token.lastUsedAt,
      staleDays: daysSince,
    };
  }
  return {
    kind: "connected",
    lastUsedAt: token.lastUsedAt,
    staleDays: null,
  };
}

/** Founder-readable badge label. */
export function tokenStateLabel(state: TokenState): string {
  switch (state.kind) {
    case "connected":
      return "Connected";
    case "awaiting_first_connection":
      return "Awaiting first connection";
    case "stale":
      return "Inactive";
    case "revoked":
      return "Revoked";
    case "expired":
      return "Expired";
  }
}

/** Tone for the badge — drives colors. */
export function tokenStateTone(
  state: TokenState,
): "success" | "warn" | "muted" | "danger" {
  switch (state.kind) {
    case "connected":
      return "success";
    case "awaiting_first_connection":
      return "muted";
    case "stale":
      return "warn";
    case "revoked":
      return "muted";
    case "expired":
      return "danger";
  }
}

/**
 * Format a delta into a human-readable "last used" line. Returns
 * `null` when the token has never been used.
 */
export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const delta = Date.now() - ms;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
