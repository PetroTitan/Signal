import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Password recovery server actions.
 *
 * Two actions cover the recovery surface:
 *
 *   - requestPasswordRecoveryAction: server-side wrapper around
 *     supabase.auth.resetPasswordForEmail. Builds the redirectTo URL
 *     from the request host + x-forwarded-proto so the recovery email
 *     points back at this deployment's /auth/callback. Never reveals
 *     whether the email is registered.
 *
 *   - updatePasswordAction: requires an active session, validates the
 *     two password fields, calls supabase.auth.updateUser, signs the
 *     user out, and redirects to /login?password_updated=1 so the next
 *     sign-in exercises the new credential through the normal flow.
 *
 * The Supabase client is mocked; we test the action's composition and
 * its security invariants (no anonymous updates, no `next` injection,
 * forced sign-out after change).
 */

const hoisted = vi.hoisted(() => ({
  resetPasswordForEmailMock: vi.fn(),
  updateUserMock: vi.fn(),
  getUserMock: vi.fn(),
  signOutMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  headersMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: hoisted.revalidatePathMock,
}));

vi.mock("next/headers", () => ({
  headers: hoisted.headersMock,
}));

vi.mock("@/lib/supabase", () => {
  class SupabaseEnvError extends Error {
    diagnostics: unknown;
    constructor(message: string, diagnostics: unknown) {
      super(message);
      this.diagnostics = diagnostics;
    }
  }
  return {
    SupabaseEnvError,
    createSupabaseServerClient: () => ({
      auth: {
        resetPasswordForEmail: hoisted.resetPasswordForEmailMock,
        updateUser: hoisted.updateUserMock,
        getUser: hoisted.getUserMock,
        signOut: hoisted.signOutMock,
      },
    }),
  };
});

import {
  requestPasswordRecoveryAction,
  updatePasswordAction,
} from "./_actions";

afterEach(() => {
  hoisted.resetPasswordForEmailMock.mockReset();
  hoisted.updateUserMock.mockReset();
  hoisted.getUserMock.mockReset();
  hoisted.signOutMock.mockReset();
  hoisted.revalidatePathMock.mockReset();
  hoisted.headersMock.mockReset();
});

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

interface HostOpts {
  host?: string | null;
  forwardedHost?: string | null;
  proto?: string | null;
}

function withHost(hostOrOpts: string | HostOpts, proto: string | null = "https") {
  const opts: HostOpts =
    typeof hostOrOpts === "string"
      ? { host: hostOrOpts, proto }
      : hostOrOpts;
  hoisted.headersMock.mockReturnValue({
    get(name: string) {
      if (name === "host") return opts.host ?? null;
      if (name === "x-forwarded-host") return opts.forwardedHost ?? null;
      if (name === "x-forwarded-proto") return opts.proto ?? null;
      return null;
    },
  });
}

describe("requestPasswordRecoveryAction", () => {
  it("rejects an empty email without calling Supabase", async () => {
    withHost("app.example.com");
    const res = await requestPasswordRecoveryAction(
      { ok: false, error: null },
      fd({ email: "   " }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/email/i);
    expect(hoisted.resetPasswordForEmailMock).not.toHaveBeenCalled();
  });

  it("sends the email with a redirectTo of /auth/callback?type=recovery (no extra query params)", async () => {
    withHost("app.example.com");
    hoisted.resetPasswordForEmailMock.mockResolvedValue({ error: null });
    const res = await requestPasswordRecoveryAction(
      { ok: false, error: null },
      fd({ email: "Worker@example.com" }),
    );
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(hoisted.resetPasswordForEmailMock).toHaveBeenCalledTimes(1);
    const [email, opts] = hoisted.resetPasswordForEmailMock.mock.calls[0];
    expect(email).toBe("worker@example.com");
    expect(opts.redirectTo).toBe(
      "https://app.example.com/auth/callback?type=recovery",
    );
    expect(opts.redirectTo).not.toContain("next=");
  });

  it("uses x-forwarded-proto when present (so deploys behind TLS terminators get https URLs)", async () => {
    withHost("app.example.com", "https");
    hoisted.resetPasswordForEmailMock.mockResolvedValue({ error: null });
    await requestPasswordRecoveryAction(
      { ok: false, error: null },
      fd({ email: "w@example.com" }),
    );
    const [, opts] = hoisted.resetPasswordForEmailMock.mock.calls[0];
    expect(opts.redirectTo).toMatch(/^https:\/\//);
  });

  it("prefers x-forwarded-host over host (so Vercel-style proxies use the public hostname)", async () => {
    withHost({
      host: "internal-runtime.vercel.app",
      forwardedHost: "signal.webmasterid.com",
      proto: "https",
    });
    hoisted.resetPasswordForEmailMock.mockResolvedValue({ error: null });
    await requestPasswordRecoveryAction(
      { ok: false, error: null },
      fd({ email: "w@example.com" }),
    );
    const [, opts] = hoisted.resetPasswordForEmailMock.mock.calls[0];
    expect(opts.redirectTo).toBe(
      "https://signal.webmasterid.com/auth/callback?type=recovery",
    );
  });

  it("fails closed (no email sent) if neither host nor x-forwarded-host is present", async () => {
    hoisted.headersMock.mockReturnValue({ get: () => null });
    const res = await requestPasswordRecoveryAction(
      { ok: false, error: null },
      fd({ email: "w@example.com" }),
    );
    expect(res.ok).toBe(false);
    expect(hoisted.resetPasswordForEmailMock).not.toHaveBeenCalled();
  });

  it("returns a friendly error if Supabase returns one", async () => {
    withHost("app.example.com");
    hoisted.resetPasswordForEmailMock.mockResolvedValue({
      error: { message: "rate_limit_exceeded" },
    });
    const res = await requestPasswordRecoveryAction(
      { ok: false, error: null },
      fd({ email: "w@example.com" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

describe("updatePasswordAction", () => {
  it("rejects when password is shorter than 8 chars without calling Supabase", async () => {
    const res = await updatePasswordAction(
      { ok: false, error: null },
      fd({ password: "short", confirm: "short" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/8 characters/i);
    expect(hoisted.getUserMock).not.toHaveBeenCalled();
    expect(hoisted.updateUserMock).not.toHaveBeenCalled();
  });

  it("rejects when confirmation does not match without calling Supabase", async () => {
    const res = await updatePasswordAction(
      { ok: false, error: null },
      fd({ password: "long-enough-1", confirm: "long-enough-2" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/do not match/i);
    expect(hoisted.getUserMock).not.toHaveBeenCalled();
    expect(hoisted.updateUserMock).not.toHaveBeenCalled();
  });

  it("refuses to update without an active recovery session (anonymous request)", async () => {
    hoisted.getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await updatePasswordAction(
      { ok: false, error: null },
      fd({ password: "longenough", confirm: "longenough" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expired or invalid/i);
    expect(hoisted.updateUserMock).not.toHaveBeenCalled();
  });

  it("forwards Supabase failures back to the user", async () => {
    hoisted.getUserMock.mockResolvedValue({
      data: { user: { id: "u-1" } },
    });
    hoisted.updateUserMock.mockResolvedValue({
      error: { message: "password too weak" },
    });
    const res = await updatePasswordAction(
      { ok: false, error: null },
      fd({ password: "longenough", confirm: "longenough" }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(hoisted.signOutMock).not.toHaveBeenCalled();
  });

  it("on success: updates the password, signs the user out, and redirects to /login?password_updated=1", async () => {
    hoisted.getUserMock.mockResolvedValue({
      data: { user: { id: "u-1" } },
    });
    hoisted.updateUserMock.mockResolvedValue({ error: null });
    hoisted.signOutMock.mockResolvedValue(undefined);

    let thrown: unknown = null;
    try {
      await updatePasswordAction(
        { ok: false, error: null },
        fd({ password: "longenough", confirm: "longenough" }),
      );
    } catch (err) {
      thrown = err;
    }

    // next/navigation's `redirect` throws a NEXT_REDIRECT sentinel; that
    // signals the redirect happened. We check the side-effects directly.
    expect(thrown).not.toBeNull();
    expect(hoisted.updateUserMock).toHaveBeenCalledWith({
      password: "longenough",
    });
    expect(hoisted.signOutMock).toHaveBeenCalledTimes(1);
    expect(hoisted.revalidatePathMock).toHaveBeenCalledWith("/", "layout");
  });
});
