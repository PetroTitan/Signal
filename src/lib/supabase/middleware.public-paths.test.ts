import { describe, expect, it } from "vitest";
import { isPublicPath } from "./middleware";

/**
 * Phase F9 — middleware public-path regression for OAuth callbacks.
 *
 * Pre-fix the middleware required an authenticated Supabase session
 * on `/api/oauth/[platform]/callback`. The OAuth callback runs after
 * a cross-site provider redirect (X / Reddit / LinkedIn); when the
 * SameSite=Lax session cookie is dropped during that round-trip, the
 * middleware would redirect to `/login?next=/api/oauth/x/callback`,
 * the state row stayed un-consumed, no platform_connections row got
 * written, and operators saw "Not signed in" with no diagnostic.
 *
 * The OAuth callback has its own auth (PKCE + one-shot state token
 * with intrinsic secrecy) and does not need the session cookie. This
 * test pins `/api/oauth` as a public-path prefix so the callback can
 * always execute its own state validation.
 */

describe("isPublicPath — /api/oauth callback access", () => {
  it("treats /api/oauth/x/callback as public (no session required after cross-site redirect)", () => {
    expect(isPublicPath("/api/oauth/x/callback")).toBe(true);
  });

  it("treats /api/oauth/reddit/callback as public", () => {
    expect(isPublicPath("/api/oauth/reddit/callback")).toBe(true);
  });

  it("treats /api/oauth/linkedin/callback as public (parity with other OAuth platforms)", () => {
    expect(isPublicPath("/api/oauth/linkedin/callback")).toBe(true);
  });

  it("treats /api/oauth/x/start as public — the route handler does its own auth check (resolveAuthenticatedContext)", () => {
    expect(isPublicPath("/api/oauth/x/start")).toBe(true);
  });
});

describe("isPublicPath — existing public paths still public (regression)", () => {
  it.each([
    ["/", true],
    ["/login", true],
    ["/signup", true],
    ["/about", true],
    ["/auth/callback", true],
    ["/api/mcp", true],
    ["/api/mcp/tools", true],
    ["/api/scheduler", true],
    ["/api/scheduler/tick", true],
  ])("isPublicPath(%s) === %s", (path, expected) => {
    expect(isPublicPath(path)).toBe(expected);
  });
});

describe("isPublicPath — gated app routes stay gated (regression)", () => {
  it.each([
    "/accounts",
    "/dashboard",
    "/settings",
    "/settings/publishing-platforms",
    "/weekly-plan",
    "/execution/items/abc",
    "/api/mcps", // similar prefix but NOT under /api/mcp
    "/api/oauths", // similar prefix but NOT under /api/oauth
  ])("isPublicPath(%s) === false (requires session)", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});
