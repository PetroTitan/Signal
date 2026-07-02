import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

/**
 * C2.1 — the scheduled digest route is gated by the shared cron-auth
 * gate (see src/lib/cron-auth.ts): it accepts CRON_SECRET (what Vercel
 * Cron sends) or SCHEDULER_TICK_TOKEN (manual). These tests pin the auth
 * boundary: no secret configured → 503; missing/wrong bearer → 401. The
 * route must never run delivery for an unauthorized caller.
 */

const ENV_KEYS = ["CRON_SECRET", "SCHEDULER_TICK_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Start hermetic: no cron secrets set unless a test opts in.
  delete process.env.CRON_SECRET;
  delete process.env.SCHEDULER_TICK_TOKEN;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function req(headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/notifications/digest?cadence=daily", {
    method: "GET",
    headers,
  });
}

describe("GET /api/notifications/digest — auth", () => {
  it("returns 503 when no cron secret is configured", async () => {
    const res = await GET(req({ authorization: "Bearer anything" }));
    expect(res.status).toBe(503);
  });

  it("returns 401 when no Authorization header is provided", async () => {
    process.env.SCHEDULER_TICK_TOKEN = "secret-token";
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns 401 when the bearer token does not match", async () => {
    process.env.SCHEDULER_TICK_TOKEN = "secret-token";
    const res = await GET(req({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("passes auth with SCHEDULER_TICK_TOKEN (then 503 only because no service-role key here)", async () => {
    process.env.SCHEDULER_TICK_TOKEN = "secret-token";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await GET(req({ authorization: "Bearer secret-token" }));
    // Auth passed; delivery can't run without the service-role client.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/service.role/i);
  });

  it("passes auth with CRON_SECRET (what Vercel Cron sends)", async () => {
    process.env.CRON_SECRET = "vercel-cron-secret";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await GET(req({ authorization: "Bearer vercel-cron-secret" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/service.role/i);
  });
});
