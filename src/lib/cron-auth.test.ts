import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeCronRequest } from "./cron-auth";

function req(authorization?: string): Request {
  return new Request("https://signal.webmasterid.com/api/scheduler/tick", {
    headers: authorization ? { authorization } : {},
  });
}

const ORIGINAL = {
  CRON_SECRET: process.env.CRON_SECRET,
  SCHEDULER_TICK_TOKEN: process.env.SCHEDULER_TICK_TOKEN,
};

describe("authorizeCronRequest", () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.SCHEDULER_TICK_TOKEN;
  });
  afterEach(() => {
    // Restore whatever the surrounding env had.
    if (ORIGINAL.CRON_SECRET === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL.CRON_SECRET;
    if (ORIGINAL.SCHEDULER_TICK_TOKEN === undefined) delete process.env.SCHEDULER_TICK_TOKEN;
    else process.env.SCHEDULER_TICK_TOKEN = ORIGINAL.SCHEDULER_TICK_TOKEN;
  });

  it("returns 503 when neither secret is configured", () => {
    const res = authorizeCronRequest(req("Bearer anything"));
    expect(res).toEqual({
      ok: false,
      status: 503,
      error: expect.stringContaining("not configured"),
    });
  });

  it("authorizes the Vercel Cron secret (CRON_SECRET)", () => {
    process.env.CRON_SECRET = "cron-secret-value";
    expect(authorizeCronRequest(req("Bearer cron-secret-value"))).toEqual({ ok: true });
  });

  it("authorizes the legacy manual token (SCHEDULER_TICK_TOKEN)", () => {
    process.env.SCHEDULER_TICK_TOKEN = "manual-token-value";
    expect(authorizeCronRequest(req("Bearer manual-token-value"))).toEqual({ ok: true });
  });

  it("authorizes either secret when both are configured", () => {
    process.env.CRON_SECRET = "cron-secret-value";
    process.env.SCHEDULER_TICK_TOKEN = "manual-token-value";
    expect(authorizeCronRequest(req("Bearer cron-secret-value"))).toEqual({ ok: true });
    expect(authorizeCronRequest(req("Bearer manual-token-value"))).toEqual({ ok: true });
  });

  it("returns 401 when a secret is set but the token is wrong", () => {
    process.env.CRON_SECRET = "cron-secret-value";
    const res = authorizeCronRequest(req("Bearer wrong-token"));
    expect(res).toEqual({ ok: false, status: 401, error: "Unauthorized." });
  });

  it("returns 401 when the Authorization header is missing", () => {
    process.env.CRON_SECRET = "cron-secret-value";
    const res = authorizeCronRequest(req());
    expect(res).toEqual({ ok: false, status: 401, error: "Unauthorized." });
  });

  it("returns 401 for a non-Bearer Authorization header", () => {
    process.env.SCHEDULER_TICK_TOKEN = "manual-token-value";
    const res = authorizeCronRequest(req("Basic manual-token-value"));
    expect(res).toEqual({ ok: false, status: 401, error: "Unauthorized." });
  });

  it("ignores empty/whitespace-only env values (treats them as unset → 503)", () => {
    process.env.CRON_SECRET = "   ";
    process.env.SCHEDULER_TICK_TOKEN = "";
    const res = authorizeCronRequest(req("Bearer   "));
    expect(res).toEqual({
      ok: false,
      status: 503,
      error: expect.stringContaining("not configured"),
    });
  });
});
