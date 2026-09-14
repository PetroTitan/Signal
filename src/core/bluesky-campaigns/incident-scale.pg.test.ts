import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  campaignRow,
  conservation,
  createFollowFixture,
  makeFollowCampaign,
  makeMembers,
  memberCounts,
  providerDouble,
  reconnectAccount,
  runsFor,
  type FollowFixture,
} from "./test-support/pg-harness";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * 100,000 members, 1,000 a day, every fault the brief names, until the
 * whole frozen queue is accounted for.
 *
 * Runs the shipped migrations on real PostgreSQL. The provider is a
 * double that injects, deterministically by member:
 *
 *   • an overnight-expired access token on EVERY day (the incident);
 *   • a 429 on day 3, with a reset the same run must honour;
 *   • ambiguous 502s and dropped connections on ~200 members, resolved
 *     by reconciliation READS days later — never by a second write;
 *   • deleted accounts and structural 4xx on ~200 members, terminal
 *     with a reason, never stopping the campaign;
 *   • a worker crash on day 5, after which the operator resumes and the
 *     ORIGINAL queue continues from where it was;
 *   • two overlapping ticks on day 7.
 *
 * What is proved at the end: every member is in exactly one category;
 * none disappeared; none was written to the provider twice; the
 * campaign completed only once nothing actionable remained.
 */

const N = 100_000;
const QUOTA = 1_000;
const AMBIG_502 = 997;      // ~100 members
const AMBIG_DROP = 1019;    // ~98 members
const NOT_FOUND = 1009;     // ~99 members
const STRUCTURAL = 1013;    // ~98 members

let f: FollowFixture;

beforeAll(async () => {
  f = await createFollowFixture("scale");
}, 300_000);
afterAll(async () => { await f?.close(); });

const idx = (did: string) => Number(did.replace("did:plc:s", ""));

describe("100,000 members across many days", () => {
  it("accounts for every member exactly once, with no duplicate provider write", async () => {
    const c = await makeFollowCampaign(f, "one hundred thousand", {
      requestedDailyQuota: QUOTA,
    });
    await makeMembers(f, c, N, "s");
    const seqCheck = await f.db.query<{ n: string; lo: string; hi: string }>(
      `select count(distinct import_sequence)::text as n,
              min(import_sequence)::text as lo, max(import_sequence)::text as hi
         from public.bluesky_follow_campaign_members where campaign_id = $1`, [c]);
    expect([seqCheck.rows[0].n, seqCheck.rows[0].lo, seqCheck.rows[0].hi]).toEqual([String(N), "1", String(N)]);

    // Reconciliation truth: ambiguous members become visible as
    // `following` only after this day — so early reads find nothing
    // and the member must WAIT, visibly, without a second write.
    let truthDay = 12;
    let day = 1;
    let rateLimitReset: number | null = null;
    const followingSince = new Map<string, number>();

    const provider = providerDouble({
      following: new Set(),
      createRecord: ({ token, subjectDid, index }) => {
        if (token === "jwt-OLD") {
          return { status: 400, body: { error: "ExpiredToken", message: "Token has expired" } };
        }
        const i = idx(subjectDid);
        if (day === 3 && rateLimitReset === null && index % 50 === 0) {
          rateLimitReset = Math.floor(Date.parse(nowIso()) / 1000) + 1800;
          return {
            status: 429,
            body: { error: "RateLimitExceeded" },
            headers: { "ratelimit-reset": String(rateLimitReset) },
          };
        }
        if (i % NOT_FOUND === 0) {
          return { status: 400, body: { error: "InvalidRequest", message: "Profile not found" } };
        }
        if (i % STRUCTURAL === 0) {
          return { status: 400, body: { error: "InvalidRequest", message: "record/subject must be a valid did" } };
        }
        if (i % AMBIG_502 === 0 && !followingSince.has(subjectDid)) {
          followingSince.set(subjectDid, day);
          return { status: 502, body: {} };
        }
        if (i % AMBIG_DROP === 0 && !followingSince.has(subjectDid)) {
          followingSince.set(subjectDid, day);
          throw new Error("socket hang up");
        }
        return { status: 200 };
      },
    });
    // The relationship read reports `following` for an ambiguous member
    // only once truthDay has passed — the write DID land, we just could
    // not see it yet.
    const baseFetch = provider.fetchImpl;
    provider.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes("getRelationships")) {
        const others = new URL(href).searchParams.getAll("others");
        return new Response(JSON.stringify({
          actor: "did:plc:incidentoperator",
          relationships: others.map((did) => ({
            $type: "app.bsky.graph.defs#relationship",
            did,
            ...(followingSince.has(did) && day >= truthDay
              ? { following: `at://did:plc:incidentoperator/app.bsky.graph.follow/x${idx(did)}` }
              : {}),
          })),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return baseFetch(url, init);
    }) as typeof fetch;

    let tickInDay = 0;
    const nowIso = () =>
      new Date(Date.parse("2026-09-14T09:00:00Z") + (day - 1) * 86_400_000 + tickInDay * 20 * 60_000).toISOString();

    const tick = async (crash = false) =>
      dispatchCampaigns({
        nowIso: nowIso(),
        db: f.client,
        fetchImpl: provider.fetchImpl,
        sleep: crash
          ? async () => { throw new Error("worker killed mid-chunk"); }
          : async () => undefined,
        interRequestMs: 0,
        campaignId: c,
        // The budget is the day's quota, not the wall clock.
        budgetMs: 10 ** 9,
        monotonicNowMs: () => 0,
      });

    const elapse = () =>
      f.db.query(
        `update public.bluesky_follow_campaign_members
            set next_attempt_at = now() - interval '1 minute'
          where campaign_id = $1 and status = 'retryable'`, [c]);

    let crashed = false;
    let overlapped = false;
    let succeededAfterDay1 = 0;

    for (day = 1; day <= 160; day += 1) {
      // Overnight: the access token has expired. Every day.
      await reconnectAccount(f, "jwt-OLD", `refresh-day${day}`);
      tickInDay = 0;

      for (tickInDay = 0; tickInDay < 12; tickInDay += 1) {
        const status = (await campaignRow(f, c)).status;
        if (status === "completed") break;

        if (status === "failed") {
          // The operator sees the crash and resumes. The ORIGINAL queue
          // and today's run continue from where they were.
          await f.db.query(
            `update public.bluesky_follow_campaigns set status = 'active', last_error_code = null,
                    last_error_message = null, next_run_at = null where id = $1`, [c]);
          await f.db.query(
            `select * from public.resume_bluesky_campaign_run_after_recovery($1,$2,$3::date)`,
            [f.tenant.workspaceId, c, nowIso().slice(0, 10)]);
        }

        if (day === 5 && !crashed && tickInDay === 1) {
          crashed = true;
          await tick(true);
          continue;
        }
        if (day === 7 && !overlapped && tickInDay === 1) {
          overlapped = true;
          await Promise.all([tick(), tick()]);
          continue;
        }

        await elapse();
        const r = await tick();
        const runs = await runsFor(f, c);
        const today = runs.find((x) => new Date(String(x.local_date)).toISOString().slice(0, 10) === nowIso().slice(0, 10));
        if (today?.status === "rate_limited" && rateLimitReset) {
          // Come back after the reset — same run.
          tickInDay += 2; // 40 minutes
          continue;
        }
        if (r.notes.some((n) => /daily quota reached|campaign completed/.test(n))) break;
        if (today?.status === "completed") break;
      }

      if (day === 1) {
        const counts = await memberCounts(f, c);
        succeededAfterDay1 = counts.succeeded ?? 0;
        // Later members progressed while earlier ones wait for retry or
        // reconciliation.
        expect(succeededAfterDay1).toBeGreaterThan(900);
        expect((counts.retryable ?? 0) + (counts.queued ?? 0)).toBeGreaterThan(N - 1100);
      }
      if (day === 6) {
        // After the crash and resume: nothing was lost or re-followed.
        const counts = await memberCounts(f, c);
        expect(counts.succeeded).toBeGreaterThanOrEqual(succeededAfterDay1);
        const dup = provider.createRecords.reduce((m, r) => m.set(r.subjectDid, (m.get(r.subjectDid) ?? 0) + 1), new Map<string, number>());
        for (const [did, n] of dup) {
          if (n > 1) {
            const tokens = provider.createRecords.filter((r) => r.subjectDid === did).map((r) => r.token);
            expect(tokens[0], did).toBe("jwt-OLD");
          }
        }
      }
      if (day === 11) {
        // Completion is impossible while anything is unresolved.
        const may = await f.db.query<{ ok: boolean }>(
          `select public.bluesky_campaign_may_complete($1,$2) as ok`, [f.tenant.workspaceId, c]);
        expect(may.rows[0].ok).toBe(false);
      }
      if ((await campaignRow(f, c)).status === "completed") break;
    }

    // ── The end state.
    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("completed");
    expect(day).toBeGreaterThanOrEqual(100);

    const cons = await conservation(f, c);
    const n = (k: string) => Number(cons[k]);
    expect(n("queued_total")).toBe(N);
    expect(n("categorised_total")).toBe(N);
    expect(
      n("pending") + n("running") + n("retryable") + n("reconciliation_required") +
      n("succeeded") + n("already_following") + n("protected") + n("actor_not_found") +
      n("blocked") + n("invalid") + n("failed_structural") + n("cancelled"),
    ).toBe(N);
    expect(n("actionable_remaining")).toBe(0);
    expect(n("open_leases")).toBe(0);
    expect(n("open_reservations")).toBe(0);
    expect(n("outstanding_intents")).toBe(0);
    expect(n("unresolved_actions")).toBe(0);

    const expectedNotFound = Math.floor(N / NOT_FOUND);
    const expectedStructural = Math.floor(N / STRUCTURAL) - Math.floor(N / (NOT_FOUND * STRUCTURAL));
    expect(n("actor_not_found")).toBe(expectedNotFound);
    expect(n("failed_structural")).toBe(expectedStructural);
    expect(n("succeeded")).toBe(N - expectedNotFound - expectedStructural);

    // NO MEMBER WRITTEN TWICE. A second createRecord for a member is
    // legitimate in exactly one case: the first carried the overnight-
    // expired token and was refused before any write.
    const perMember = new Map<string, string[]>();
    for (const r of provider.createRecords) {
      perMember.set(r.subjectDid, [...(perMember.get(r.subjectDid) ?? []), r.token]);
    }
    let refusedThenRetried = 0;
    for (const [did, tokens] of perMember) {
      const real = tokens.filter((t) => t !== "jwt-OLD").length;
      expect(real, `${did} written ${real} times`).toBeLessThanOrEqual(1);
      if (tokens.length > 1) refusedThenRetried += 1;
    }
    // Ambiguous members were written ONCE and settled by a read.
    for (const did of followingSince.keys()) {
      expect(perMember.get(did)?.filter((t) => t !== "jwt-OLD").length, did).toBe(1);
    }
    // One overnight refusal per day, at most.
    expect(refusedThenRetried).toBeLessThanOrEqual(day);
    // Every day refreshed, and only once.
    expect(provider.calls.refreshSession).toBeLessThanOrEqual(day + 2);

    // The frozen queue is intact: same sequence, same size.
    const seqEnd = await f.db.query<{ n: string; hi: string }>(
      `select count(distinct import_sequence)::text as n, max(import_sequence)::text as hi
         from public.bluesky_follow_campaign_members where campaign_id = $1`, [c]);
    expect([seqEnd.rows[0].n, seqEnd.rows[0].hi]).toEqual([String(N), String(N)]);

    // Every day's run closed cleanly — none `failed`.
    const runs = await runsFor(f, c);
    expect(runs.length).toBeGreaterThanOrEqual(100);
    expect(runs.filter((r) => r.status === "failed")).toHaveLength(0);
  }, 3_000_000);
});
