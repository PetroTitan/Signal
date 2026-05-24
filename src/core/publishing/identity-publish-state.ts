/**
 * Identity-level publish state resolution.
 *
 * Today Signal carries four overlapping concepts that all surface as
 * "connected":
 *
 *   1. Platform capability         — can Signal automate at all? Pure
 *                                    static data from platform-guidance.ts
 *                                    (publishingMode: api | manual |
 *                                    not_implemented).
 *   2. Workspace integration state — does the *workspace* have the
 *                                    env-var-level credentials for
 *                                    automated publishing? (E.g.
 *                                    BLUESKY_APP_PASSWORD, DEVTO_API_KEY,
 *                                    HASHNODE_API_KEY, TELEGRAM_BOT_TOKEN.)
 *   3. Identity authentication     — does *this specific identity*
 *                                    have a valid OAuth/credential link?
 *                                    Stored per-account_id in
 *                                    platform_connections.
 *   4. Publish mode                — the resolved capability: what can
 *                                    we actually do for THIS identity
 *                                    right now?
 *
 * Before this module, the three lower layers leaked into the UI in
 * ad-hoc ways: the /accounts capabilities panel renders "Connected"
 * for layer 2 (env-vars present), even when layer 3 (identity OAuth)
 * is empty. Operators see "Bluesky · Connected" on the platform row
 * and "@webmasterid.bsky.social · Not connected" on the identity
 * card and have to reconcile two contradictory truths.
 *
 * This module makes the resolution deterministic. The output is a
 * single `IdentityPublishState` that the UI and any future
 * publishing-policy code can both render and gate on.
 *
 * Pure function. No I/O. The caller assembles the inputs from
 * existing repositories.
 */

import type { FounderPlatform } from "./platform-guidance";

// =====================================================================
// The six identity-level publish states
// =====================================================================

export const IDENTITY_PUBLISH_STATES = [
  /**
   * Identity is fully authenticated and can publish through the
   * platform's automated path (or, for distribution-only platforms
   * with a configured workspace integration, has its compose-intent
   * + return-permalink flow ready).
   */
  "connected",
  /**
   * Identity had a valid auth but the credential has expired or the
   * platform requires reauthorization. Drafts and history are
   * preserved; the operator needs to reconnect.
   */
  "expired",
  /**
   * Identity needs authentication before automated publishing can
   * happen. Covers: no connection row at all, revoked, generic
   * not_connected, ready_to_connect, pending_authorization,
   * connection_error.
   */
  "pending_auth",
  /**
   * Token is valid, but the account/handle the OAuth flow returned
   * does not match the identity's declared handle. Publishing under
   * this state would post to the wrong account. Operator must
   * reconnect with the correct platform account.
   */
  "mismatched",
  /**
   * Platform never auto-publishes for this identity. Signal prepares
   * the post; the operator publishes manually on the platform. This
   * is a steady state, NOT an error.
   */
  "manual",
  /**
   * Platform has no publishing integration in Signal at all (not yet
   * implemented or removed). The identity exists for record-keeping;
   * drafts can still be generated.
   */
  "unsupported",
  /**
   * Identity has been explicitly disabled by the operator or
   * archived. Excluded from publishing flows regardless of upstream
   * auth state.
   */
  "disabled",
] as const;

export type IdentityPublishState = (typeof IDENTITY_PUBLISH_STATES)[number];

// =====================================================================
// Input contract — read by the resolver
// =====================================================================

/**
 * Per-platform capability layer. The resolver reads this *static*
 * data (it is not workspace- or identity-scoped) to know whether the
 * platform can be automated at all. Derived from `platform-guidance.ts`
 * but kept as a separate interface so the resolver stays decoupled
 * from the editorial guidance surface.
 */
export interface PlatformCapability {
  /**
   * The platform's publishing path:
   *   - "api"             — Signal can publish directly via API
   *                          (Bluesky, dev.to, Hashnode, Telegram)
   *   - "manual"          — operator must publish on the platform
   *                          itself (Reddit pre-API approval)
   *   - "distribution"    — Signal prepares + opens the native
   *                          composer; operator confirms and clicks
   *                          publish (X, LinkedIn, YouTube, Threads,
   *                          Instagram)
   *   - "not_implemented" — Signal has no publishing path here yet
   */
  publishingMode: "api" | "manual" | "distribution" | "not_implemented";
}

/**
 * Workspace-level integration state. Whether the workspace owner has
 * configured the env-var-level credentials Signal needs to talk to
 * the platform's API at all (e.g. BLUESKY_APP_PASSWORD). Independent
 * of any specific identity. `null` for platforms without an
 * env-var-level integration (e.g. Reddit OAuth, where each identity
 * carries its own token).
 */
export interface WorkspaceIntegration {
  /**
   * true when Signal has the workspace-level credentials it needs
   * to attempt automated publishing on this platform. Does not
   * imply any identity is authenticated.
   */
  configured: boolean;
}

/**
 * Identity-level OAuth/auth state. Mirrors the existing
 * platform_connections row for (workspace, platform, account_id).
 * `null` means no connection row exists for this identity at all.
 */
export interface IdentityConnection {
  /**
   * The OAuth/credential lifecycle status from platform_connections.
   * Kept narrow on purpose — we map the wider DB enum into these
   * five buckets here so the resolver doesn't have to know every
   * future DB value.
   */
  authStatus:
    | "connected"
    | "expired"
    | "needs_reauth"
    | "revoked"
    | "not_connected";
  /**
   * The platform this connection row authenticates against. Used to
   * detect rows wired to the wrong platform.
   */
  platform: FounderPlatform;
  /**
   * The workspace this connection belongs to. Used to detect a
   * row that leaked across workspaces (defense in depth — RLS
   * should already prevent this).
   */
  workspaceId: string;
  /**
   * The handle (e.g. "@webmasterid.bsky.social", "u/Webmasterid-core")
   * the OAuth flow returned for this token. `null` when the
   * connector didn't surface a handle.
   */
  authenticatedHandle: string | null;
  /**
   * The platform's own account id (DID, user_id, …) the OAuth flow
   * returned, when available. Compared against the identity's
   * provider_account_id if the caller has it.
   */
  providerAccountId: string | null;
  /** Optional: ISO timestamp of expiry, if known. Drives logging only. */
  expiresAt?: string | null;
  /**
   * True when a prior auth attempt persisted a handle-mismatch
   * record on the connection (e.g. the OAuth callback wrote
   * `metadata.handle_mismatch = { declared, authenticated,
   * observedAt }` because the authenticated handle disagreed with
   * the identity's declared handle).
   *
   * The callback sets `connectionStatus = "error"` in that case to
   * keep `publishing-policy.ts` refusing to publish. Without this
   * flag the resolver would map "error" through
   * narrowConnectionAuthStatus → "not_connected" → `pending_auth`
   * and the operator would lose the mismatch explanation after the
   * redirect cycle. Setting `handleMismatchObserved = true` makes
   * the resolver short-circuit to `mismatched` so the UI keeps
   * surfacing the expected-vs-authenticated banner.
   *
   * Cleared automatically by a successful reconnect:
   * `upsertPlatformConnection` replaces `metadata` wholesale, so
   * the success-path metadata (which does NOT include
   * handle_mismatch) drops the prior payload.
   */
  handleMismatchObserved?: boolean;
}

/**
 * The identity itself. Reads from growth_accounts.
 */
export interface IdentityRecord {
  platform: FounderPlatform;
  /** The workspace this identity belongs to. */
  workspaceId: string;
  /**
   * The handle the operator declared for this identity
   * (growth_accounts.handle). May be null when the identity is a
   * platform like Instagram where the handle is recorded only on
   * the platform itself. Used by the mismatch check.
   */
  declaredHandle: string | null;
  /**
   * Operator-set disabled flag OR archived status. When true, the
   * resolver shortcuts to `disabled` regardless of upstream auth.
   */
  disabled: boolean;
  /** growth_accounts.status. archived ⇒ disabled. */
  lifecycleStatus:
    | "planned"
    | "warming"
    | "active"
    | "paused"
    | "setup_needed"
    | "awaiting_manual_creation"
    | "archived";
}

export interface ResolveInput {
  identity: IdentityRecord;
  platform: PlatformCapability;
  /**
   * Workspace integration state for this platform. Pass `null` when
   * the platform has no env-var-level integration (Reddit, X,
   * LinkedIn, YouTube, Threads, Instagram, Indie Hackers — they
   * either rely on per-identity OAuth or are distribution/manual
   * only).
   */
  workspace: WorkspaceIntegration | null;
  /**
   * The identity's own auth row. `null` when no row exists yet.
   */
  connection: IdentityConnection | null;
}

// =====================================================================
// Resolver
// =====================================================================

/**
 * Map a raw platform_connections.connection_status value into the
 * narrow IdentityConnection.authStatus enum the resolver consumes.
 * Caller-side helper so repository code doesn't have to know the
 * resolver's vocabulary.
 */
export function narrowConnectionAuthStatus(
  raw: string | null | undefined,
): IdentityConnection["authStatus"] {
  switch (raw) {
    case "connected":
    case "healthy":
      return "connected";
    case "expired":
      return "expired";
    case "reauthorization_required":
      return "needs_reauth";
    case "revoked":
      return "revoked";
    // not_connected, ready_to_connect, pending_authorization,
    // degraded, disabled, error, null/undefined — all collapse to
    // "not_connected" from the resolver's perspective.
    default:
      return "not_connected";
  }
}

/**
 * Normalize a handle for comparison. Strips common prefixes
 * (`@`, `u/`), lowercases, and collapses surrounding whitespace.
 * Two handles that normalize to the same string belong to the same
 * account from the resolver's perspective.
 */
export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/^u\//, "").replace(/^@/, "");
}

/**
 * Compare a declared identity handle against the handle the OAuth
 * flow returned. Returns:
 *   - "match"        — both present and equal
 *   - "mismatch"     — both present and different
 *   - "indeterminate"— either side absent; we can't decide.
 */
export function compareHandles(
  declared: string | null,
  authenticated: string | null,
): "match" | "mismatch" | "indeterminate" {
  const d = normalizeHandle(declared);
  const a = normalizeHandle(authenticated);
  if (!d || !a) return "indeterminate";
  return d === a ? "match" : "mismatch";
}

/**
 * Pure deterministic resolver. Same input ⇒ same output, every time.
 * No I/O.
 *
 * Resolution order matters — earlier rules short-circuit later ones:
 *
 *   1. Identity explicitly disabled or archived → "disabled".
 *   2. Platform has no publishing path → "unsupported".
 *   3. Platform is distribution/manual-only → "manual" (regardless
 *      of any OAuth state on the identity — distribution platforms
 *      don't authenticate Signal to publish; the operator does that
 *      on the platform itself).
 *   4. Platform is API-automated, workspace integration missing
 *      → "pending_auth" (workspace-level setup needed before any
 *      identity can connect — this matches what the operator sees on
 *      the platform-credentials side of the UI).
 *   5. Identity has no connection row → "pending_auth".
 *   6. Connection row is wired to a different platform than the
 *      identity → "pending_auth" (the row is meaningless for this
 *      identity — defense in depth against caller wiring errors).
 *   7. Connection row belongs to a different workspace than the
 *      identity → "pending_auth" (defense in depth against RLS
 *      slips — must never trust a cross-workspace row).
 *   8. Identity connection has expired → "expired".
 *   9. Identity connection needs reauth → "expired".
 *  10. Identity connection revoked → "pending_auth".
 *  11. Identity connection not_connected → "pending_auth".
 *  12. Identity connection connected but the authenticated handle
 *      does not match the declared identity handle → "mismatched"
 *      (token is valid but bound to a DIFFERENT account on the
 *      platform; publishing under this state would post to the
 *      wrong handle).
 *  13. Identity connection connected → "connected".
 */
export function resolveIdentityPublishState(
  input: ResolveInput,
): IdentityPublishState {
  const { identity, platform, workspace, connection } = input;

  // 1. Disabled / archived shortcuts beat everything.
  if (identity.disabled || identity.lifecycleStatus === "archived") {
    return "disabled";
  }

  // 2. Unsupported platform — no path forward.
  if (platform.publishingMode === "not_implemented") {
    return "unsupported";
  }

  // 3. Distribution and manual platforms never reach "connected".
  // Signal doesn't authenticate to publish for the operator on these
  // — the operator publishes on the platform itself. "Manual" is a
  // steady state.
  if (
    platform.publishingMode === "manual" ||
    platform.publishingMode === "distribution"
  ) {
    return "manual";
  }

  // 4. API-automated path requires workspace integration.
  // When the workspace integration is missing, no identity can be
  // connected — we surface that as pending_auth at the identity
  // level so the UI doesn't claim "Connected" for an identity that
  // could not possibly be authenticated.
  if (workspace && !workspace.configured) {
    return "pending_auth";
  }

  // 5. No connection row at all.
  if (!connection) {
    return "pending_auth";
  }

  // 6. Platform mismatch — the connection row authenticates against
  // a different platform than the identity claims. This shouldn't
  // happen in normal data flow (callers query by platform) but we
  // refuse to trust it if it does.
  if (connection.platform !== identity.platform) {
    return "pending_auth";
  }

  // 7. Workspace mismatch — defense in depth. RLS should prevent
  // cross-workspace rows from being read, but if a caller assembles
  // an input incorrectly we must not honour it.
  if (connection.workspaceId !== identity.workspaceId) {
    return "pending_auth";
  }

  // 7b. Persistent handle-mismatch — short-circuit to `mismatched`
  // when the connection carries a recorded mismatch from a prior
  // auth attempt. This overrides the auth-status switch below
  // because reconnecting (which is the only path that clears the
  // mismatch) is also the only useful action for the operator —
  // even if the token has also expired, "reconnect with correct
  // account" is the right next step.
  if (connection.handleMismatchObserved) {
    return "mismatched";
  }

  // 8-11. Map the auth status.
  switch (connection.authStatus) {
    case "expired":
    case "needs_reauth":
      return "expired";
    case "revoked":
    case "not_connected":
      return "pending_auth";
    case "connected":
      // 12. Handle match check. Only runs when both sides have a
      // handle; if either is missing we can't decide, and we trust
      // the auth status.
      if (
        compareHandles(
          identity.declaredHandle,
          connection.authenticatedHandle,
        ) === "mismatch"
      ) {
        return "mismatched";
      }
      return "connected";
  }
}

// =====================================================================
// UI helpers — labels and tones
// =====================================================================

/**
 * Human-readable label for each state. Kept calm and accurate —
 * "Connected" is reserved for the identity-level connected state
 * only.
 */
export const IDENTITY_PUBLISH_STATE_LABELS: Record<
  IdentityPublishState,
  string
> = {
  connected: "Connected",
  expired: "Reauthorize",
  pending_auth: "Not connected",
  mismatched: "Account mismatch",
  manual: "Manual publish",
  unsupported: "Not supported",
  disabled: "Disabled",
};

/**
 * Operator-facing one-line hint matching each state.
 */
export const IDENTITY_PUBLISH_STATE_HINTS: Record<
  IdentityPublishState,
  string
> = {
  connected: "Signal can publish for this identity.",
  expired: "Connection expired. Reauthorize to resume publishing.",
  pending_auth: "Identity needs authentication before Signal can publish.",
  mismatched:
    "Connected account differs from this identity's handle. Reconnect with the correct account.",
  manual:
    "Signal prepares the post; you publish on the platform itself.",
  unsupported: "Signal has no publishing path for this platform yet.",
  disabled: "Identity is disabled. Re-enable to resume.",
};

/**
 * Visual tone for each state. Consumed by the UI pill component.
 * "connected" is the only `success` tone — every other state is
 * either an action needed (warn / info) or a neutral steady state.
 */
export const IDENTITY_PUBLISH_STATE_TONES: Record<
  IdentityPublishState,
  "success" | "warn" | "info" | "muted" | "danger"
> = {
  connected: "success",
  expired: "warn",
  pending_auth: "info",
  // Mismatched is the riskiest non-publishing state: the token works,
  // so a naive caller could ship a post to the wrong account if they
  // skipped this check. Surface it loudly.
  mismatched: "danger",
  manual: "info",
  unsupported: "muted",
  disabled: "muted",
};

/**
 * Convenience: returns true when the state means automated
 * publishing is currently possible.
 */
export function canAutoPublish(state: IdentityPublishState): boolean {
  return state === "connected";
}

/**
 * Map the editorial-side `publishingMode` (from platform-guidance.ts,
 * which mixes "manual" and "distribution" under the same enum value
 * with a separate `distributionOnly` flag) into the resolver's
 * narrower PlatformCapability shape. Keeps the resolver agnostic of
 * the editorial surface.
 */
export function toPlatformCapability(input: {
  publishingMode: "api" | "manual" | "not_implemented";
  distributionOnly?: boolean;
}): PlatformCapability {
  if (input.publishingMode === "api") return { publishingMode: "api" };
  if (input.publishingMode === "not_implemented")
    return { publishingMode: "not_implemented" };
  // publishingMode === "manual": distribution platforms (X, LinkedIn,
  // YouTube, Threads, Instagram) get their own enum value so the UI
  // can label them distinctly.
  return {
    publishingMode: input.distributionOnly ? "distribution" : "manual",
  };
}
