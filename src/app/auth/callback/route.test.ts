import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Password recovery — /auth/callback flow detection + session-cookie
 * persistence into the redirect response.
 *
 * Behavior covered:
 *   1. PKCE `?code=` → exchangeCodeForSession → /reset-password on
 *      type=recovery; safelisted `next` or /dashboard otherwise.
 *   2. OTP `?token_hash=` → verifyOtp → same routing.
 *   3. **Session cookies returned by Supabase MUST land on the redirect
 *      Response itself** (response.cookies.set), not just on the
 *      request-scoped next/headers cookie store. Recovery sessions are
 *      worthless if the browser never sees Set-Cookie before following
 *      the Location header to /reset-password. This was the root cause
 *      of the "Current password required when setting new password"
 *      bug: cookies dropped → middleware bounce → manual sign-in →
 *      non-recovery session → secure-password-change wall.
 *   4. Failure paths redirect to /login with a distinguishable error
 *      code (recovery_link_invalid vs callback_failed).
 *
 * The Supabase client is constructed inline via @supabase/ssr's
 * createServerClient. We mock createServerClient to capture the
 * cookies adapter and exercise it directly — that's the only way to
 * assert that setAll writes to the right response object.
 */

interface CaptureRef {
  setAll: ((cookies: Array<{ name: string; value: string; options?: unknown }>) => void) | null;
  verifyOtpMock: ReturnType<typeof vi.fn>;
  exchangeCodeForSessionMock: ReturnType<typeof vi.fn>;
  cookieStoreSet: ReturnType<typeof vi.fn>;
}

const hoisted = vi.hoisted(() => {
  const capture: CaptureRef = {
    setAll: null,
    verifyOtpMock: vi.fn(),
    exchangeCodeForSessionMock: vi.fn(),
    cookieStoreSet: vi.fn(),
  };
  return { capture };
});

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: {
    cookies: {
      setAll: (
        cookies: Array<{ name: string; value: string; options?: unknown }>,
      ) => void;
    };
  }) => {
    hoisted.capture.setAll = opts.cookies.setAll;
    return {
      auth: {
        verifyOtp: hoisted.capture.verifyOtpMock,
        exchangeCodeForSession: hoisted.capture.exchangeCodeForSessionMock,
      },
    };
  },
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    getAll: () => [],
    set: hoisted.capture.cookieStoreSet,
  }),
}));

vi.mock("@/lib/supabase", () => ({
  requireSupabaseEnv: () => ({ url: "https://x.supabase.co", anonKey: "k" }),
}));

import { GET } from "./route";

beforeEach(() => {
  hoisted.capture.setAll = null;
});

afterEach(() => {
  hoisted.capture.verifyOtpMock.mockReset();
  hoisted.capture.exchangeCodeForSessionMock.mockReset();
  hoisted.capture.cookieStoreSet.mockReset();
});

function req(url: string): Request {
  return new Request(url);
}

/**
 * Make verifyOtp / exchangeCodeForSession invoke the captured setAll
 * with a session-shaped cookie batch, like the real SSR client would
 * after a successful sign-in / verify.
 */
function sessionWritingSuccess() {
  return async () => {
    if (hoisted.capture.setAll) {
      hoisted.capture.setAll([
        {
          name: "sb-x-auth-token",
          value: "session-jwt",
          options: { path: "/", httpOnly: true, sameSite: "lax", secure: true },
        },
      ]);
    }
    return { error: null };
  };
}

describe("/auth/callback — password recovery flow (PKCE `?code=`)", () => {
  it("forces redirect to /reset-password when type=recovery, ignoring `next`", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockImplementation(
      sessionWritingSuccess(),
    );
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?code=abc&type=recovery&next=/dashboard",
      ),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/reset-password",
    );
    expect(hoisted.capture.exchangeCodeForSessionMock).toHaveBeenCalledWith(
      "abc",
    );
    expect(hoisted.capture.verifyOtpMock).not.toHaveBeenCalled();
  });

  it("forces redirect to /reset-password when type=recovery even if `next` is attacker-controlled", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockImplementation(
      sessionWritingSuccess(),
    );
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?code=abc&type=recovery&next=https://evil.example",
      ),
    );
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.hostname).toBe("app.example.com");
    expect(parsed.pathname).toBe("/reset-password");
  });

  it("redirects to /login?error=recovery_link_invalid when exchange fails on a recovery link", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockResolvedValue({
      error: { message: "expired" },
    });
    const res = await GET(
      req("https://app.example.com/auth/callback?code=abc&type=recovery"),
    );
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.get("error")).toBe("recovery_link_invalid");
  });
});

describe("/auth/callback — password recovery flow (OTP `?token_hash=`)", () => {
  it("verifies the token hash and redirects to /reset-password on success", async () => {
    hoisted.capture.verifyOtpMock.mockImplementation(sessionWritingSuccess());
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=ABC123&type=recovery",
      ),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/reset-password",
    );
    expect(hoisted.capture.verifyOtpMock).toHaveBeenCalledWith({
      type: "recovery",
      token_hash: "ABC123",
    });
    expect(hoisted.capture.exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it("redirects to /login?error=recovery_link_invalid when verifyOtp fails", async () => {
    hoisted.capture.verifyOtpMock.mockResolvedValue({
      error: { message: "Token has expired or is invalid" },
    });
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=ABC123&type=recovery",
      ),
    );
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.get("error")).toBe("recovery_link_invalid");
  });

  it("prefers token_hash over code when both are present", async () => {
    hoisted.capture.verifyOtpMock.mockImplementation(sessionWritingSuccess());
    await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=H&code=C&type=recovery",
      ),
    );
    expect(hoisted.capture.verifyOtpMock).toHaveBeenCalledTimes(1);
    expect(hoisted.capture.exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it("handles non-recovery OTP types (e.g., signup confirmation) with safelisted `next`", async () => {
    hoisted.capture.verifyOtpMock.mockImplementation(sessionWritingSuccess());
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=ABC&type=signup&next=/onboarding",
      ),
    );
    expect(new URL(res.headers.get("location")!).pathname).toBe("/onboarding");
    expect(hoisted.capture.verifyOtpMock).toHaveBeenCalledWith({
      type: "signup",
      token_hash: "ABC",
    });
  });
});

/**
 * THE bug this whole refactor exists to prevent. If the session cookies
 * Supabase writes during verifyOtp / exchangeCodeForSession do not end
 * up on the redirect response, the browser never stores them, the next
 * request to /reset-password has no session, the user signs in
 * manually with their old password (creating a non-recovery session),
 * and updateUser({ password }) fails with "Current password required".
 */
describe("/auth/callback — session-cookie persistence into redirect response", () => {
  it("OTP success: cookies written by Supabase land on the redirect response (Set-Cookie present)", async () => {
    hoisted.capture.verifyOtpMock.mockImplementation(sessionWritingSuccess());
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=ABC123&type=recovery",
      ),
    );
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain("sb-x-auth-token=session-jwt");
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/reset-password",
    );
  });

  it("PKCE success: cookies written by Supabase land on the redirect response (Set-Cookie present)", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockImplementation(
      sessionWritingSuccess(),
    );
    const res = await GET(
      req("https://app.example.com/auth/callback?code=abc&type=recovery"),
    );
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie!).toContain("sb-x-auth-token=session-jwt");
  });

  it("failed verifyOtp: no session cookies leak onto the error redirect", async () => {
    hoisted.capture.verifyOtpMock.mockResolvedValue({
      error: { message: "expired" },
    });
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=ABC123&type=recovery",
      ),
    );
    const setCookie = res.headers.get("set-cookie");
    if (setCookie !== null) {
      expect(setCookie).not.toContain("sb-x-auth-token=session-jwt");
    }
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("/auth/callback — non-recovery flows (regression)", () => {
  it("redirects to safelisted `next` when no type param is present", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockImplementation(
      sessionWritingSuccess(),
    );
    const res = await GET(
      req("https://app.example.com/auth/callback?code=abc&next=/settings"),
    );
    expect(new URL(res.headers.get("location")!).pathname).toBe("/settings");
  });

  it("defaults to /dashboard when no `next` and no `type` is provided", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockImplementation(
      sessionWritingSuccess(),
    );
    const res = await GET(req("https://app.example.com/auth/callback?code=abc"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
  });

  it("rejects off-host `next` and falls back to /dashboard", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockImplementation(
      sessionWritingSuccess(),
    );
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?code=abc&next=https://evil.example",
      ),
    );
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.hostname).toBe("app.example.com");
    expect(parsed.pathname).toBe("/dashboard");
  });

  it("rejects protocol-relative `next` (//evil.example) and falls back to /dashboard", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockImplementation(
      sessionWritingSuccess(),
    );
    const res = await GET(
      req("https://app.example.com/auth/callback?code=abc&next=//evil.example"),
    );
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.hostname).toBe("app.example.com");
    expect(parsed.pathname).toBe("/dashboard");
  });

  it("redirects to /login?error=callback_failed (not recovery_link_invalid) when exchange fails on non-recovery", async () => {
    hoisted.capture.exchangeCodeForSessionMock.mockResolvedValue({
      error: { message: "bad code" },
    });
    const res = await GET(req("https://app.example.com/auth/callback?code=abc"));
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.get("error")).toBe("callback_failed");
  });
});
