import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  actionsFor,
  assertConserved,
  campaignRow,
  createFollowFixture,
  identityState,
  makeFollowCampaign,
  makeMembers,
  memberCounts,
  providerDouble,
  reconnectAccount,
  runsFor,
  type FollowFixture,
} from "./test-support/pg-harness";
import { createPostgrestDouble, type PostgrestDouble } from "@/test/pg/postgrest-double";
import { dispatchCampaigns } from "./dispatcher.server";
import { dispatchFairly } from "./dispatch-round.server";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

/**
 * PRODUCTION INCIDENT, 2026-09-15 (second) — identity
 * @webmasterid.bsky.social, account a9411a9b-dfd6-4d71-95f0-8874b2708cf8,
 * connection 4ad3bd2a-950b-41ce-aaa2-0b736bd01de3.
 *
 *   15:20:54Z  the PR #198 coordinator refreshed the session:
 *              connected / healthy / token_generation = 1.
 *   15:35:47Z  GET /api/campaigns/bluesky/tick
 *              (Vercel request 7ggxw-1789486547108-3213ab3ab693):
 *                createRecord → 400 ExpiredToken
 *                acquire_bluesky_refresh_lease → POST ok
 *                NO refreshSession
 *                createRecord → 400 ExpiredToken again
 *              The trace marks the platform_connections reads "Using
 *              cache".
 *   after      connection connected/healthy gen 1; growth account
 *              connected; campaigns active; run waiting_for_auth; the
 *              pending action stores ExpiredToken.
 *
 * THE MECHANISM. The service-role client speaks PostgREST over the
 * global `fetch`, which in a Next.js route handler is Next's patched
 * fetch. In a GET-only route handler the request store never sets
 * `revalidate = 0` (that only happens for routes with non-GET methods),
 * so the "auto no cache" rule for Authorization-bearing requests does
 * not fire, `force-dynamic` only flags the route, and every request
 * without `cache: "no-store"` is keyed and stored in the persistent
 * Data Cache. A worker read generation N; another invocation committed
 * N+1; the worker's lease verdict said `reload`; the reload read the
 * SAME cached generation-N row; the retry carried the same expired JWT.
 *
 * This file drives the REAL service-role client (`createClient` from
 * supabase-js, exactly as `createSupabaseServiceRoleClient` builds it)
 * through a `fetch` double that translates PostgREST into SQL on a real
 * PostgreSQL and reproduces the Data Cache's decision. Only the Bluesky
 * network is a separate double. No follow is performed.
 */

const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://cache-repro.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.anon-signature-test",
  SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.service-signature-test",
};

let f: FollowFixture;
let pgrest: PostgrestDouble;
const originalFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

const T_WARM = "2026-09-15T15:05:00Z";
const T_REFRESH = "2026-09-15T15:20:54Z";
const T_TICK = "2026-09-15T15:35:47Z";
const T_NEXT = "2026-09-15T15:40:47Z";
const T_NEXT2 = "2026-09-15T15:45:47Z";

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  f = await createFollowFixture("cached-reload");
  pgrest = createPostgrestDouble(f.db, { dataCache: true });
  // The service-role client resolves the GLOBAL fetch — in production,
  // Next's patched one. Here, the Data Cache double.
  globalThis.fetch = pgrest.fetch;
}, 180_000);
afterAll(async () => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await f?.close();
});
afterEach(async () => {
  pgrest.clearCache();
  pgrest.clearLog();
  pgrest.clearStats();
  await f.db.query(
    `update public.bluesky_follow_campaigns set status = 'cancelled' where workspace_id = $1 and status <> 'cancelled'`,
    [f.tenant.workspaceId]);
  await f.db.query(
    `update public.bluesky_identity_daily_usage set attempts_made = 0, follows_created = 0 where operator_account_id = $1`,
    [f.tenant.identityId]);
});

/** The client exactly as `createSupabaseServiceRoleClient` builds it — on this branch. */
function serviceClient() {
  const c = createSupabaseServiceRoleClient();
  if (!c) throw new Error("service client unavailable in test");
  return c;
}

/** The client as origin/main 946019c…c91bf90 built it: supabase-js defaults, no cache directive. */
function legacyServiceClient() {
  return createClient(ENV.NEXT_PUBLIC_SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-signal-service-role": "signal-server-worker" } },
  });
}

const tick = (db: ReturnType<typeof serviceClient>, fetchImpl: typeof fetch, nowIso: string, campaignId: string) =>
  dispatchCampaigns({ db, nowIso, fetchImpl, campaignId, sleep: async () => undefined, interRequestMs: 0, maxChunks: 1 });

const fair = (db: ReturnType<typeof serviceClient>, fetchImpl: typeof fetch, nowIso: string) =>
  dispatchFairly({
    db, nowIso, fetchImpl, sleep: async () => undefined, interRequestMs: 0,
    deadlineMs: 600_000, chunkCostMs: 1, settleMarginMs: 0, workspaceId: f.tenant.workspaceId,
  });

/** The OTHER invocation: refreshes through an uncached path and commits N+1. */
async function otherInvocationRefreshes(nowIso: string) {
  const provider = providerDouble({});
  const s = await resolveRelationshipSession({
    workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId,
    db: f.client, fetchImpl: provider.fetchImpl, nowIso,
  });
  if (!s.ok) throw new Error(s.message);
  const renewed = await s.refreshOnce();
  if (!renewed.ok) throw new Error(renewed.message);
  expect(provider.calls.refreshSession).toBe(1);
  return renewed;
}

/** Reads of the identity's token row, with whether the Data Cache served them. */
const tokenReads = () =>
  pgrest.requests.filter((r) => r.method === "GET" && r.table === "platform_connections" && /access_token_encrypted/.test(r.path));

describe("A client WITHOUT the no-store transport, on a Data Cache — the shape origin/main c91bf90 ran", () => {
  /*
   * ON c91bf90 (before this fix) this exact sequence reproduced
   * production: the reload after the lease verdict was served from
   * cache, the retry carried the same expired JWT, no refreshSession
   * was made, the campaign was stopped "for reauthorization" while the
   * identity read connected at N+1, and every later delivery
   * reactivated and re-stopped it (the campaign-stop PATCH, answering
   * 200, was itself replayed from cache, leaving the campaign `active`
   * with its run `waiting_for_auth` — production's snapshot). The run
   * is kept next to the incident document.
   *
   * WITH the fix the transport is no longer the only defence: a reload
   * that does not observe a newer generation is refused as a stale read
   * and the worker yields. So a client that somehow bypassed the
   * wrapper is CONTAINED — one refused request, nothing marked, no loop
   * — but makes no progress. That is what this test pins.
   */
  it("the coordinator refuses the cached generation-N row on reload (stale_read → yield): one refused request, no refresh, no contradiction, no progress", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const legacy = legacyServiceClient();
    const c = await makeFollowCampaign(f, "webmasterid-auto-300", { requestedDailyQuota: 300 });
    await makeMembers(f, c, 60, "wa");

    // 15:05 — an earlier delivery. The token is still valid; every
    // read the client makes is stored in the Data Cache at generation N.
    const early = providerDouble({ createRecord: () => ({ status: 200 }) });
    await tick(legacy, early.fetchImpl, T_WARM, c);
    expect((await memberCounts(f, c)).succeeded).toBe(20);
    const n = (await identityState(f)).generation;
    expect(pgrest.stats.cacheStores).toBeGreaterThan(0);
    expect(tokenReads().some((r) => !r.fromCache)).toBe(true);

    // 15:20:54 — another invocation meets the expiry first and refreshes
    // through the coordinator: generation N+1, jwt-NEW.
    await otherInvocationRefreshes(T_REFRESH);
    const afterRefresh = await identityState(f);
    expect(afterRefresh.generation).toBe(n + 1);
    expect(afterRefresh.status).toBe("connected");

    // 15:35:47 — this delivery. The provider now refuses jwt-OLD and
    // accepts jwt-NEW; a refreshSession WOULD succeed if asked.
    pgrest.clearLog();
    const provider = providerDouble({});
    const result = await tick(legacy, provider.fetchImpl, T_TICK, c);

    // The cache still served the stale row on reload …
    const acquire = pgrest.requests.findIndex((r) => r.method === "POST" && r.table === "acquire_bluesky_refresh_lease");
    expect(acquire).toBeGreaterThan(-1);
    const reloadRead = pgrest.requests.slice(acquire + 1).find((r) => r.method === "GET" && r.table === "platform_connections" && /access_token_encrypted/.test(r.path));
    expect(reloadRead?.fromCache).toBe(true);
    // … and the coordinator refused to act on it: ONE refused request
    // (not two), no refresh, a yield.
    expect(provider.calls.createRecord).toBe(1);
    expect(provider.createRecords.map((r) => r.token)).toEqual(["jwt-OLD"]);
    expect(provider.calls.refreshSession).toBe(0);
    expect(result.notes.join(" ")).toMatch(/fresh session|next delivery/);

    // No contradiction: the identity says connected at N+1, and so do
    // the campaign and the run. The refused member is owed its retry.
    const id = await identityState(f);
    expect(id.generation).toBe(n + 1);
    expect(id.status).toBe("connected");
    expect(id.leaseOwner).toBeNull();
    expect((await campaignRow(f, c)).status).toBe("active");
    expect((await campaignRow(f, c)).auth_stopped_at_generation).toBeNull();
    expect((await runsFor(f, c))[0].status).toBe("running");
    const pending = (await actionsFor(f, c)).filter((a) => a.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].provider_error_code).toBe("ExpiredToken");
    expect(pending[0].provider_in_flight_at).toBeNull();
    expect((await memberCounts(f, c)).succeeded).toBe(20);
    await assertConserved(f, c, expect);
  });
});

describe("FIXED — every service-role request bypasses the Data Cache", () => {
  it("the delivery after another invocation's refresh reads generation N+1 fresh, uses jwt-NEW, spends no refresh, and leaves no contradiction", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const db = serviceClient();
    const c = await makeFollowCampaign(f, "webmasterid-auto-300", { requestedDailyQuota: 300 });
    await makeMembers(f, c, 60, "wf");

    const early = providerDouble({ createRecord: () => ({ status: 200 }) });
    await tick(db, early.fetchImpl, T_WARM, c);
    expect((await memberCounts(f, c)).succeeded).toBe(20);
    const n = (await identityState(f)).generation;
    // Nothing was stored: every request opted out.
    expect(pgrest.stats.cacheStores).toBe(0);
    expect(pgrest.stats.noStore).toBe(pgrest.stats.requests);

    await otherInvocationRefreshes(T_REFRESH);
    expect((await identityState(f)).generation).toBe(n + 1);

    pgrest.clearLog();
    const provider = providerDouble({});
    await tick(db, provider.fetchImpl, T_TICK, c);

    expect(pgrest.stats.cacheHits).toBe(0);
    expect(tokenReads().every((r) => !r.fromCache && r.cache === "no-store")).toBe(true);
    expect(provider.calls.refreshSession).toBe(0);
    expect(provider.createRecords.filter((r) => r.token === "jwt-OLD")).toHaveLength(0);
    expect(provider.createRecords.filter((r) => r.token === "jwt-NEW")).toHaveLength(20);
    expect((await memberCounts(f, c)).succeeded).toBe(40);
    expect((await campaignRow(f, c)).status).toBe("active");
    expect((await runsFor(f, c))[0].status).toBe("running");
    expect((await identityState(f)).status).toBe("connected");
    await assertConserved(f, c, expect);
  });

  it("a reload after the lease verdict is a REAL read: the cached generation-N row is never returned (the client had warmed the cache before N+1 existed)", async () => {
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    // The legacy client warms the cache with generation N.
    const legacy = legacyServiceClient();
    const c = await makeFollowCampaign(f, "reload-real", { requestedDailyQuota: 300 });
    await makeMembers(f, c, 30, "rr");
    const early = providerDouble({ createRecord: () => ({ status: 200 }) });
    await tick(legacy, early.fetchImpl, T_WARM, c);
    const n = (await identityState(f)).generation;
    expect(pgrest.stats.cacheStores).toBeGreaterThan(0);

    // This worker holds a session read at N (resolved through the fixed
    // client — fresh, but N is still current at this instant) …
    const db = serviceClient();
    const provider = providerDouble({});
    const stale = await resolveRelationshipSession({
      workspaceId: f.tenant.workspaceId, accountId: f.tenant.identityId, db, fetchImpl: provider.fetchImpl, nowIso: T_TICK,
    });
    expect(stale.ok).toBe(true);
    if (!stale.ok) throw new Error("unreachable");
    expect(stale.tokenGeneration).toBe(n);
    // … then the other invocation commits N+1 …
    await otherInvocationRefreshes(T_REFRESH);
    // … and this worker's rejection leads to `reload`, which must read
    // N+1 from the database, not N from the cache the legacy client left.
    pgrest.clearLog();
    const hitsBefore = pgrest.stats.cacheHits;
    const renewed = await stale.refreshOnce();
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error("unreachable");
    expect(renewed.tokenGeneration).toBe(n + 1);
    expect(renewed.accessJwt).toBe("jwt-NEW");
    expect(provider.calls.refreshSession).toBe(0);
    expect(tokenReads().length).toBeGreaterThan(0);
    expect(tokenReads().every((r) => r.cache === "no-store" && !r.fromCache)).toBe(true);
    expect(pgrest.stats.cacheHits).toBe(hitsBefore);
  });
});
