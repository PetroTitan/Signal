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
    // C2.1 — scheduled digest cron route shares the scheduler's
    // secret-gated public-path convention.
    ["/api/notifications", true],
    ["/api/notifications/digest", true],
    // D.1G — metrics refresh cron route, same convention.
    ["/api/metrics", true],
    ["/api/metrics/refresh", true],
  ])("isPublicPath(%s) === %s", (path, expected) => {
    expect(isPublicPath(path)).toBe(expected);
  });
});

describe("isPublicPath — notification digest cron access", () => {
  it("treats /api/notifications/digest as public (route enforces the cron secret)", () => {
    expect(isPublicPath("/api/notifications/digest")).toBe(true);
  });
  it("does NOT treat a similar-prefix path as public", () => {
    expect(isPublicPath("/api/notificationss")).toBe(false);
  });
});

describe("isPublicPath — metrics refresh cron access", () => {
  it("treats /api/metrics/refresh as public (route enforces the cron secret)", () => {
    expect(isPublicPath("/api/metrics/refresh")).toBe(true);
  });
  it("keeps the session-gated results export private (NOT public)", () => {
    expect(isPublicPath("/api/results/export")).toBe(false);
  });
  it("does NOT treat a similar-prefix path as public", () => {
    expect(isPublicPath("/api/metricss")).toBe(false);
  });
});

/**
 * Password recovery — both /forgot-password and /reset-password are
 * public at the middleware layer.
 *
 * /forgot-password: anyone can request a recovery email; the action
 * never reveals whether the address is registered.
 *
 * /reset-password: the page does its own server-side session check via
 * getUser() and renders an "expired link" panel when no recovery
 * session exists; updatePasswordAction re-checks getUser() as
 * defense-in-depth. The path is public at the middleware so the
 * /auth/callback → /reset-password redirect is not gated by a freshly
 * minted cookie that the middleware has not yet observed — that race
 * was bouncing users into the normal sign-in flow, creating a non-
 * recovery session, and tripping Supabase's Secure-Password-Change
 * policy with "Current password required".
 */
describe("isPublicPath — password recovery paths", () => {
  it("treats /forgot-password as public", () => {
    expect(isPublicPath("/forgot-password")).toBe(true);
  });
  it("treats /reset-password as public (page + action enforce recovery session)", () => {
    expect(isPublicPath("/reset-password")).toBe(true);
  });
});

describe("isPublicPath — gated app routes stay gated (regression)", () => {
  it.each([
    "/accounts",
    "/dashboard",
    "/settings",
    "/settings/publishing-platforms",
    "/weekly-plan",
    "/library",
    "/results",
    "/notifications",
    "/execution",
    "/execution/items/abc",
    "/api/mcps", // similar prefix but NOT under /api/mcp
    "/api/oauths", // similar prefix but NOT under /api/oauth
    "/academyx", // similar prefix but NOT under /academy
  ])("isPublicPath(%s) === false (requires session)", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

/**
 * Public marketing + Academy visibility (the homepage/Academy/SEO fix).
 * Logged-out visitors must reach the homepage, the whole Academy, and
 * the SEO/AI-crawler files without being bounced to /login.
 */
describe("isPublicPath — public marketing + Academy + SEO files", () => {
  it.each([
    "/",
    "/academy",
    "/academy/what-is-signal",
    "/academy/supported-metrics-by-platform",
    "/sitemap.xml",
    "/robots.txt",
    "/llms.txt",
    "/login",
    "/signup",
  ])("isPublicPath(%s) === true (no session required)", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });
});
