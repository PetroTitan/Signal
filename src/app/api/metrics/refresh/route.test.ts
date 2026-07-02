import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

/**
 * D.1G — the metrics refresh route shares the cron-auth gate (see
 * src/lib/cron-auth.ts): it accepts CRON_SECRET (what Vercel Cron sends)
 * or SCHEDULER_TICK_TOKEN (manual). No secret configured → 503;
 * missing/wrong bearer → 401. An unauthorized cron call must never run a
 * refresh.
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
  return new Request("https://app.test/api/metrics/refresh", { method: "GET", headers });
}

describe("GET /api/metrics/refresh — auth", () => {
  it("503 when no cron secret is configured", async () => {
    const res = await GET(req({ authorization: "Bearer x" }));
    expect(res.status).toBe(503);
  });

  it("401 with no Authorization header", async () => {
    process.env.SCHEDULER_TICK_TOKEN = "secret";
    expect((await GET(req())).status).toBe(401);
  });

  it("401 with a wrong bearer token", async () => {
    process.env.SCHEDULER_TICK_TOKEN = "secret";
    expect((await GET(req({ authorization: "Bearer nope" }))).status).toBe(401);
  });

  it("passes auth with SCHEDULER_TICK_TOKEN (503 only because no service-role key here)", async () => {
    process.env.SCHEDULER_TICK_TOKEN = "secret";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await GET(req({ authorization: "Bearer secret" }));
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
