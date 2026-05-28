import { describe, expect, it } from "vitest";
import { OAUTH_PROVIDERS } from "./oauth-provider";

/**
 * Phase F9 — X authorize-host regression.
 *
 * The X OAuth authorize endpoint MUST be served on `x.com`, not the
 * legacy `twitter.com` host. Post-rebrand, an unauthenticated user
 * hitting `twitter.com/i/oauth2/authorize?...` gets cross-host-
 * redirected to `x.com/login`, and the OAuth authorize context is
 * lost on that hop in some browser/cookie shapes — the user lands
 * on `x.com/home` after login instead of the consent screen, the
 * Signal callback never fires, and the operator sees "Not signed
 * in" forever.
 *
 * Using `x.com` directly keeps the entire flow on a single host
 * (login → consent → callback). This test pins the host so a
 * future "consolidate to twitter.com for legacy parity" patch can't
 * silently re-introduce the bug.
 *
 * Token / revoke / profile remain on `api.twitter.com` — those are
 * server-to-server API calls, no user-facing browser hop, no
 * cross-host context loss. The API hosts are aliased by X (also
 * reachable as `api.x.com`); the choice is a no-op.
 */

describe("OAUTH_PROVIDERS.x — authorize host", () => {
  it("uses https://x.com/i/oauth2/authorize (NOT twitter.com)", () => {
    expect(OAUTH_PROVIDERS.x.authorizeUrl).toBe(
      "https://x.com/i/oauth2/authorize",
    );
  });

  it("does NOT use the legacy twitter.com authorize host", () => {
    expect(OAUTH_PROVIDERS.x.authorizeUrl).not.toContain("twitter.com");
  });

  it("uses https (not http)", () => {
    expect(OAUTH_PROVIDERS.x.authorizeUrl.startsWith("https://")).toBe(true);
  });

  it("keeps the standard /i/oauth2/authorize path", () => {
    const url = new URL(OAUTH_PROVIDERS.x.authorizeUrl);
    expect(url.pathname).toBe("/i/oauth2/authorize");
  });

  it("does NOT have a trailing slash on the authorize path", () => {
    expect(OAUTH_PROVIDERS.x.authorizeUrl.endsWith("/")).toBe(false);
  });

  it("still uses PKCE (S256) — host change must not relax PKCE", () => {
    expect(OAUTH_PROVIDERS.x.pkce).toBe(true);
  });

  it("keeps token + revoke + profile on the api.twitter.com host (server-to-server; no browser hop)", () => {
    // These endpoints are aliased by X (also reachable on api.x.com).
    // The host stays on api.twitter.com to avoid touching the four
    // call sites and the existing test surface for those flows.
    expect(OAUTH_PROVIDERS.x.tokenUrl).toBe(
      "https://api.twitter.com/2/oauth2/token",
    );
    expect(OAUTH_PROVIDERS.x.revokeUrl).toBe(
      "https://api.twitter.com/2/oauth2/revoke",
    );
    expect(OAUTH_PROVIDERS.x.profileUrl).toBe(
      "https://api.twitter.com/2/users/me",
    );
  });
});

describe("OAUTH_PROVIDERS — other platforms untouched (regression)", () => {
  it("Reddit authorize host is unchanged", () => {
    expect(OAUTH_PROVIDERS.reddit.authorizeUrl).toBe(
      "https://www.reddit.com/api/v1/authorize",
    );
  });

  it("LinkedIn authorize host is unchanged", () => {
    expect(OAUTH_PROVIDERS.linkedin.authorizeUrl).toBe(
      "https://www.linkedin.com/oauth/v2/authorization",
    );
  });
});
