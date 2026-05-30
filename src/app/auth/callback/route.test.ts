import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Password recovery — /auth/callback flow detection.
 *
 * The recovery email link lands here with `type=recovery&code=...`. The
 * route must:
 *   1. Exchange `code` for a session via Supabase.
 *   2. Force-redirect to /reset-password regardless of `next` (an
 *      attacker MUST NOT be able to divert a freshly-minted recovery
 *      session into the rest of the app via `?next=/foo`).
 *   3. If the exchange fails, redirect to /login with a distinguishable
 *      error code so the UI can render a recovery-specific message.
 *
 * Non-recovery flows (no `type` param, or `type=signup` from email
 * confirmation) must continue to honor a safelisted `next`.
 */

const hoisted = vi.hoisted(() => ({
  exchangeCodeForSessionMock: vi.fn(),
  verifyOtpMock: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => ({
    auth: {
      exchangeCodeForSession: hoisted.exchangeCodeForSessionMock,
      verifyOtp: hoisted.verifyOtpMock,
    },
  }),
}));

import { GET } from "./route";

afterEach(() => {
  hoisted.exchangeCodeForSessionMock.mockReset();
  hoisted.verifyOtpMock.mockReset();
});

function req(url: string): Request {
  return new Request(url);
}

describe("/auth/callback — password recovery flow (PKCE `?code=`)", () => {
  it("forces redirect to /reset-password when type=recovery, ignoring `next`", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?code=abc&type=recovery&next=/dashboard",
      ),
    );
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(new URL(location!).pathname).toBe("/reset-password");
    expect(hoisted.exchangeCodeForSessionMock).toHaveBeenCalledWith("abc");
    expect(hoisted.verifyOtpMock).not.toHaveBeenCalled();
  });

  it("forces redirect to /reset-password when type=recovery even if `next` is attacker-controlled", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?code=abc&type=recovery&next=https://evil.example",
      ),
    );
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const parsed = new URL(location!);
    expect(parsed.hostname).toBe("app.example.com");
    expect(parsed.pathname).toBe("/reset-password");
  });

  it("redirects to /login?error=recovery_link_invalid when exchange fails on a recovery link", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({
      error: { message: "expired" },
    });
    const res = await GET(
      req("https://app.example.com/auth/callback?code=abc&type=recovery"),
    );
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    const parsed = new URL(location!);
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.get("error")).toBe("recovery_link_invalid");
  });
});

/**
 * The Supabase-recommended Next.js email template uses
 * `?token_hash={{ .TokenHash }}&type=recovery`, which does NOT rely on
 * a PKCE code_verifier cookie. This is the path that lets users open
 * the recovery link from a different browser or device.
 */
describe("/auth/callback — password recovery flow (OTP `?token_hash=`)", () => {
  it("verifies the token hash and redirects to /reset-password on success", async () => {
    hoisted.verifyOtpMock.mockResolvedValue({ error: null });
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=ABC123&type=recovery",
      ),
    );
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/reset-password",
    );
    expect(hoisted.verifyOtpMock).toHaveBeenCalledWith({
      type: "recovery",
      token_hash: "ABC123",
    });
    expect(hoisted.exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it("redirects to /login?error=recovery_link_invalid when verifyOtp fails", async () => {
    hoisted.verifyOtpMock.mockResolvedValue({
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
    hoisted.verifyOtpMock.mockResolvedValue({ error: null });
    await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=H&code=C&type=recovery",
      ),
    );
    expect(hoisted.verifyOtpMock).toHaveBeenCalledTimes(1);
    expect(hoisted.exchangeCodeForSessionMock).not.toHaveBeenCalled();
  });

  it("handles non-recovery OTP types (e.g., signup confirmation) with /dashboard fallback", async () => {
    hoisted.verifyOtpMock.mockResolvedValue({ error: null });
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?token_hash=ABC&type=signup&next=/onboarding",
      ),
    );
    const parsed = new URL(res.headers.get("location")!);
    expect(parsed.pathname).toBe("/onboarding");
    expect(hoisted.verifyOtpMock).toHaveBeenCalledWith({
      type: "signup",
      token_hash: "ABC",
    });
  });
});

describe("/auth/callback — non-recovery flows (regression)", () => {
  it("redirects to safelisted `next` when no type param is present", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    const res = await GET(
      req("https://app.example.com/auth/callback?code=abc&next=/settings"),
    );
    const location = res.headers.get("location");
    expect(location).not.toBeNull();
    expect(new URL(location!).pathname).toBe("/settings");
  });

  it("defaults to /dashboard when no `next` and no `type` is provided", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    const res = await GET(req("https://app.example.com/auth/callback?code=abc"));
    const location = res.headers.get("location");
    expect(new URL(location!).pathname).toBe("/dashboard");
  });

  it("rejects off-host `next` and falls back to /dashboard", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    const res = await GET(
      req(
        "https://app.example.com/auth/callback?code=abc&next=https://evil.example",
      ),
    );
    const location = res.headers.get("location");
    const parsed = new URL(location!);
    expect(parsed.hostname).toBe("app.example.com");
    expect(parsed.pathname).toBe("/dashboard");
  });

  it("rejects protocol-relative `next` (//evil.example) and falls back to /dashboard", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({ error: null });
    const res = await GET(
      req("https://app.example.com/auth/callback?code=abc&next=//evil.example"),
    );
    const location = res.headers.get("location");
    const parsed = new URL(location!);
    expect(parsed.hostname).toBe("app.example.com");
    expect(parsed.pathname).toBe("/dashboard");
  });

  it("redirects to /login?error=callback_failed (not recovery_link_invalid) when exchange fails on non-recovery", async () => {
    hoisted.exchangeCodeForSessionMock.mockResolvedValue({
      error: { message: "bad code" },
    });
    const res = await GET(req("https://app.example.com/auth/callback?code=abc"));
    const location = res.headers.get("location");
    const parsed = new URL(location!);
    expect(parsed.pathname).toBe("/login");
    expect(parsed.searchParams.get("error")).toBe("callback_failed");
  });
});
