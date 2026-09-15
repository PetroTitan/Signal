import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  actionsFor,
  campaignRow,
  conservation,
  createFollowFixture,
  makeFollowCampaign,
  makeMembers,
  memberCounts,
  providerDouble,
  reconnectAccount,
  runsFor,
  storedTokens,
  type FollowFixture,
} from "./test-support/pg-harness";
import { dispatchCampaigns } from "./dispatcher.server";
import { dispatchFairly } from "./dispatch-round.server";
import { resolveRelationshipSession } from "@/core/bluesky-relationships/session.server";
import { getSessionInfo, isRefreshableAuthFailure } from "@/core/bluesky-relationships/atproto-graph";

/**
 * PRODUCTION INCIDENT, 2026-09-15 — campaign "webmasterid-auto-300"
 * (`cdbb2b76…`), identity @webmasterid.bsky.social, which also carries
 * "WebmasterID 1-3" (`0b13dce0…`).
 *
 * What production showed, in order:
 *
 *   13:00:48  today's run started; 13:01:08 last chunk; run PAUSED with
 *             last_error_code = reauthorization_required; campaign
 *             reauthorization_required; one action pending with
 *             provider_error_code ExpiredToken and no in-flight marker.
 *   13:40:50  the identity was refreshed successfully by another path:
 *             platform_connections connected/healthy, metadata
 *             "Session refreshed for webmasterid.bsky.social".
 *   after     the campaign stayed reauthorization_required, the run
 *             stayed paused, no chunk ran, and last_dispatched_at kept
 *             advancing on every tick.
 *
 * Replayed here against the shipped migrations, the real session
 * resolver, the real refresh path and the real connection persistence.
 * Only the network is a double, and it counts every request. No follow
 * or unfollow is performed anywhere.
 *
 * Every assertion below states the REQUIRED behaviour. On origin/main
 * (946019c) the three scenarios fail exactly as production did; the
 * output of that run is kept next to the incident document.
 */

let f: FollowFixture;
const T0 = "2026-09-15T13:00:00Z";
const later = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

beforeAll(async () => {
  f = await createFollowFixture("incident-0915");
}, 180_000);
afterAll(async () => { await f?.close(); });

const dispatch = (
  fetchImpl: typeof fetch,
  over: Record<string, unknown> = {},
) =>
  dispatchCampaigns({
    nowIso: T0,
    db: f.client,
    fetchImpl,
    sleep: async () => undefined,
    interRequestMs: 0,
    ...over,
  });

const fair = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  dispatchFairly({
    nowIso: T0,
    db: f.client,
    fetchImpl,
    sleep: async () => undefined,
    interRequestMs: 0,
    deadlineMs: 120_000,
    chunkCostMs: 1,
    settleMarginMs: 0,
    workspaceId: f.tenant.workspaceId,
    ...over,
  });

const connectionRow = async () =>
  (await f.db.query<{ connection_status: string; health_status: string; metadata: Record<string, unknown> }>(
    `select connection_status, health_status, metadata
       from public.platform_connections where id = $1`, [f.connectionId])).rows[0];

describe("C — a stale refresh failure after another worker already rotated the token", () => {
  it("must not overwrite the newer healthy credentials, must not stop the campaign, and must continue on the newer generation", async () => {
    const c = await makeFollowCampaign(f, "webmasterid-auto-300", { requestedDailyQuota: 300 });
    await makeMembers(f, c, 25, "a3");
    await reconnectAccount(f, "jwt-OLD", "refresh-1");

    // The access token expired mid-chunk. This worker's refresh reaches
    // the provider AFTER another worker on the same identity — the
    // publishing scheduler on the same */5 cron, the sibling campaign,
    // or a duplicate delivery — has already spent the single-use
    // refresh token and persisted the rotated pair. Bluesky therefore
    // rejects THIS worker's refresh: the token it presents was consumed.
    const inner = providerDouble({
      refreshSession: () => ({
        ok: false,
        status: 400,
        body: { error: "ExpiredToken", message: "Token has been revoked" },
      }),
    });
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("refreshSession")) {
        await reconnectAccount(f, "jwt-NEW", "refresh-2");
      }
      return inner.fetchImpl(url, init);
    }) as typeof fetch;

    const result = await dispatch(fetchImpl, { campaignId: c });

    // The newer credentials are the truth and must survive this
    // worker's stale failure. Production wrote `expired` over them.
    const tokens = await storedTokens(f);
    expect(tokens.access).toBe("jwt-NEW");
    expect(tokens.refresh).toBe("refresh-2");
    expect(tokens.status).toBe("connected");
    expect(tokens.accountStatus).toBe("connected");

    // The campaign was never stopped, the run is not paused, and the
    // pass continued on the newer generation: every member followed,
    // exactly one createRecord was refused, exactly one refresh was
    // asked of the provider.
    const camp = await campaignRow(f, c);
    expect(camp.status).not.toBe("reauthorization_required");
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).not.toBe("paused");
    expect(inner.calls.refreshSession).toBe(1);
    expect((await memberCounts(f, c)).succeeded).toBe(25);
    expect(inner.createRecords.filter((r) => r.token === "jwt-OLD")).toHaveLength(1);
    expect(inner.createRecords.filter((r) => r.token === "jwt-NEW")).toHaveLength(25);
    expect(result.notes.join(" ")).not.toMatch(/reauthorization/i);

    const cons = await conservation(f, c);
    expect(Number(cons.categorised_total)).toBe(25);
    expect(Number(cons.actionable_remaining)).toBe(0);
  });
});

describe("D — the identity is refreshed successfully while the campaign and run are stopped for authentication", () => {
  it("the next delivery recovers the campaign and the SAME run, and the rejected-before-write member gets a real retry", async () => {
    const c = await makeFollowCampaign(f, "WebmasterID 1-3", { requestedDailyQuota: 300 });
    await makeMembers(f, c, 12, "d1");

    // The production shape at 13:01: connection expired (by the stale
    // failure), campaign reauthorization_required, today's run paused
    // for it, one member refused before any write with its action
    // re-opened and pending.
    const run = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,'2026-09-15',300,300,null)`,
      [f.tenant.workspaceId, c])).rows[0].id;
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set status = 'paused', last_error_code = 'reauthorization_required',
              last_error_message = 'Bluesky rejected this identity''s session.',
              attempted_count = 1, started_at = '2026-09-15T13:00:48Z',
              last_chunk_at = '2026-09-15T13:01:08Z'
        where id = $1`, [run]);
    await f.db.query(
      `update public.bluesky_follow_campaigns
          set status = 'reauthorization_required',
              last_error_code = 'reauthorization_required',
              next_run_at = '2026-09-15T13:00:47Z'
        where id = $1`, [c]);
    const member = (await f.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaign_members
        where campaign_id = $1 and subject_did = 'did:plc:d11'`, [c])).rows[0].id;
    await f.db.query(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did, actor_did,
          status, campaign_id, campaign_run_id, campaign_member_id,
          provider_error_code, provider_error_message, provider_status_code)
       values ($1,$2,'follow','did:plc:d11',$3,'pending',$4,$5,$6,'ExpiredToken','Token has expired',400)`,
      [f.tenant.workspaceId, f.tenant.identityId, "did:plc:incidentoperator", c, run, member]);
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'retryable', attempt_count = 1, next_attempt_at = now() - interval '1 minute'
        where id = $1`, [member]);
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    await f.db.query(
      `update public.platform_connections
          set connection_status = 'expired', health_status = 'expired' where id = $1`, [f.connectionId]);
    await f.db.query(
      `update public.growth_accounts set connection_status = 'expired' where id = $1`,
      [f.tenant.identityId]);

    // 13:40:50 — the identity is refreshed by another path: here, the
    // operator's "Check account access", which exercises the session,
    // meets the expired token, and spends the stored refresh token once
    // through the SAME resolver the workers use.
    const check = providerDouble({});
    const session = await resolveRelationshipSession({
      workspaceId: f.tenant.workspaceId,
      accountId: f.tenant.identityId,
      db: f.client,
      fetchImpl: check.fetchImpl,
      nowIso: "2026-09-15T13:40:50Z",
    });
    expect(session.ok).toBe(true);
    if (!session.ok) throw new Error("unreachable");
    const probe = await getSessionInfo({ accessJwt: session.accessJwt, pds: session.service, fetchImpl: check.fetchImpl });
    expect(!probe.ok && isRefreshableAuthFailure(probe)).toBe(true);
    const renewed = await session.refreshOnce();
    expect(renewed.ok).toBe(true);
    expect(check.calls.refreshSession).toBe(1);

    // What production showed after 13:40:50 — and the half it did not
    // show. The connection is connected/healthy with the refresh
    // message; the identity mirror must agree.
    const conn = await connectionRow();
    expect(conn.connection_status).toBe("connected");
    expect(conn.health_status).toBe("healthy");
    expect(String(conn.metadata.last_message)).toMatch(/Session refreshed for/);
    expect((await storedTokens(f)).accountStatus).toBe("connected");

    // The next scheduler delivery, inside the window.
    const provider = providerDouble({ createRecord: () => ({ status: 200 }) });
    const round = await fair(provider.fetchImpl, { nowIso: later(45) });

    // Recovered: the campaign is active again (or finished), the SAME
    // run continued with its counters, the error fields are clear.
    const camp = await campaignRow(f, c);
    expect(["active", "completed"]).toContain(camp.status);
    expect(camp.last_error_code).toBeNull();
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run);
    expect(["running", "completed"]).toContain(runs[0].status);
    expect(runs[0].last_error_code).toBeNull();
    expect(Number(runs[0].attempted_count)).toBeGreaterThan(1);

    // A chunk actually ran, and the refused member received a REAL
    // retry — one createRecord, the same action row, now succeeded.
    expect(round.follow.chunksProcessed).toBeGreaterThan(0);
    expect(provider.createRecords.filter((r) => r.subjectDid === "did:plc:d11")).toHaveLength(1);
    const a = (await actionsFor(f, c)).filter((x) => x.subject_did === "did:plc:d11");
    expect(a).toHaveLength(1);
    expect(a[0].status).toBe("succeeded");
    expect((await memberCounts(f, c)).succeeded).toBe(12);
    // No second refresh was needed: the refreshed session was persisted
    // and the worker started from it.
    expect(provider.calls.refreshSession).toBe(0);
    const cons = await conservation(f, c);
    expect(Number(cons.categorised_total)).toBe(12);
    expect(Number(cons.actionable_remaining)).toBe(0);
  });
});

describe("the fairness stamp", () => {
  it("does not advance for a campaign that could not be served", async () => {
    const c = await makeFollowCampaign(f, "blocked", { requestedDailyQuota: 300 });
    await makeMembers(f, c, 5, "bl");
    await f.db.query(
      `update public.bluesky_follow_campaigns
          set status = 'reauthorization_required', last_error_code = 'reauthorization_required',
              next_run_at = $2, last_dispatched_at = null
        where id = $1`, [c, later(50)]);
    // The identity genuinely needs the operator: its current refresh
    // credential was rejected.
    await f.db.query(
      `update public.platform_connections
          set connection_status = 'reauthorization_required', health_status = 'expired' where id = $1`,
      [f.connectionId]);
    await f.db.query(
      `update public.growth_accounts set connection_status = 'reauthorization_required' where id = $1`,
      [f.tenant.identityId]);

    const provider = providerDouble({});
    for (let tick = 1; tick <= 3; tick += 1) {
      await fair(provider.fetchImpl, { nowIso: later(50 + tick * 5), campaignId: c });
    }
    // Zero chunks, zero provider calls — and therefore no claim to have
    // been served. Production advanced this stamp on every tick, which
    // would push a stopped campaign behind every other one for good.
    expect(provider.calls.createRecord).toBe(0);
    expect(provider.calls.refreshSession).toBe(0);
    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("reauthorization_required");
    expect(camp.last_dispatched_at).toBeNull();
  });
});
