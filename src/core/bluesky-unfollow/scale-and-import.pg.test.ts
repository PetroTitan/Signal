import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  ACTOR_DID,
  createUnfollowFixture,
  makeUnfollowCampaign,
  mockSession,
  providerDouble,
  type UnfollowFixture,
} from "./test-support/harness";

vi.mock("@/core/bluesky-relationships/session.server", () => mockSession());

import { resumeUnfollowImport } from "./import.server";
import { listSourcePage, importUnfollowChunk } from "@/repositories/bluesky-unfollow-repository";

/**
 * Queue construction at scale, against the REAL migration.
 *
 * The properties under test are the ones that decide whether a 100,000
 * profile campaign is honest:
 *
 *   • every member imported EXACTLY once — none twice, none missed;
 *   • the walk costs the same at row 1 and row 100,000 (keyset, no
 *     OFFSET);
 *   • a stable total order with a unique tie-breaker, so rows with
 *     identical timestamps cannot shuffle between pages;
 *   • two concurrent builders duplicate work but never a member;
 *   • the source is frozen once building starts;
 *   • activation is refused while the queue is incomplete.
 *
 * Nothing here loads a queue into memory. The assertions are all
 * database counts.
 */

let f: UnfollowFixture;

beforeAll(async () => {
  f = await createUnfollowFixture("scale");
}, 180_000);
afterAll(async () => { await f?.close(); });

/**
 * Seed N candidates this identity believes it follows.
 *
 * Every row gets the SAME `last_discovered_at`, deliberately: a
 * timestamp-ordered walk over identical timestamps is exactly where a
 * weak tie-breaker loses or repeats rows, and the unfollow cursor is
 * `subject_did` alone precisely so that cannot happen.
 */
async function seedCandidates(
  count: number,
  prefix: string,
  identityId?: string,
): Promise<void> {
  const owner = identityId ?? f.tenant.identityId;
  const CHUNK = 2000;
  for (let start = 0; start < count; start += CHUNK) {
    const values: string[] = [];
    for (let i = start; i < Math.min(start + CHUNK, count); i += 1) {
      const did = `did:plc:${prefix}${String(i).padStart(7, "0")}`;
      values.push(
        `('${f.tenant.workspaceId}','${owner}','${did}',` +
          `'${prefix}${i}.bsky.social','following',` +
          `'at://${ACTOR_DID}/app.bsky.graph.follow/rk${i}','rk${i}',` +
          `timestamptz '2026-01-01 00:00:00Z')`,
      );
    }
    await f.db.query(
      `insert into public.bluesky_candidates
         (workspace_id, operator_account_id, subject_did, handle,
          relationship_state, follow_uri, follow_rkey, last_discovered_at)
       values ${values.join(",")}`,
    );
  }
}

const memberCount = async (campaignId: string): Promise<number> => {
  const r = await f.db.query<{ n: string }>(
    `select count(*)::text as n from public.bluesky_follow_campaign_members
      where campaign_id = $1`,
    [campaignId],
  );
  return Number(r.rows[0].n);
};

// =====================================================================

describe("100,000 members", () => {
  it(
    "imports every one EXACTLY once, by keyset, with a contiguous sequence",
    async () => {
      const N = 100_000;
      await seedCandidates(N, "big");
      const c = await makeUnfollowCampaign(f, "one hundred thousand", {
        status: "draft",
      });

      // Called repeatedly, exactly as the setup screen calls it. Where
      // to continue from is the database's business; the caller sends
      // only the campaign.
      let progress = await resumeUnfollowImport({
        workspaceId: f.tenant.workspaceId,
        campaignId: c,
        operatorAccountId: f.tenant.identityId,
        sourceKind: "filtered_candidates",
        targetProfileId: null,
        sourceCampaignId: null,
        db: f.client,
      });
      let calls = 1;
      while (!progress.complete && calls < 200) {
        progress = await resumeUnfollowImport({
          workspaceId: f.tenant.workspaceId,
          campaignId: c,
          operatorAccountId: f.tenant.identityId,
          sourceKind: "filtered_candidates",
          targetProfileId: null,
          sourceCampaignId: null,
          db: f.client,
        });
        calls += 1;
      }

      expect(progress.complete).toBe(true);
      expect(progress.status).toBe("ready");
      expect(progress.campaignStatus).toBe("ready");
      expect(await memberCount(c)).toBe(N);

      // NONE TWICE. The unique (campaign_id, subject_did) makes this
      // structural, and the count proves it held.
      const distinct = await f.db.query<{ n: string }>(
        `select count(distinct subject_did)::text as n
           from public.bluesky_follow_campaign_members where campaign_id = $1`,
        [c],
      );
      expect(Number(distinct.rows[0].n)).toBe(N);

      // NONE MISSED. Every seeded DID is present.
      const missing = await f.db.query<{ n: string }>(
        `select count(*)::text as n
           from public.bluesky_candidates cand
          where cand.workspace_id = $1
            and cand.operator_account_id = $2
            and cand.subject_did like 'did:plc:big%'
            and not exists (
              select 1 from public.bluesky_follow_campaign_members m
               where m.campaign_id = $3 and m.subject_did = cand.subject_did)`,
        [f.tenant.workspaceId, f.tenant.identityId, c],
      );
      expect(Number(missing.rows[0].n)).toBe(0);

      // The ordering key is a contiguous 1..N with no gaps and no
      // duplicates — which is what makes claiming a keyset scan rather
      // than an offset.
      const seq = await f.db.query<{ lo: string; hi: string; n: string }>(
        `select min(import_sequence)::text as lo,
                max(import_sequence)::text as hi,
                count(distinct import_sequence)::text as n
           from public.bluesky_follow_campaign_members where campaign_id = $1`,
        [c],
      );
      expect(seq.rows[0].lo).toBe("1");
      expect(seq.rows[0].hi).toBe(String(N));
      expect(seq.rows[0].n).toBe(String(N));

      // Every member carries the record identity needed to delete it.
      // A queue of 100,000 DIDs with no record keys would be a queue
      // nothing could act on without guessing.
      const withRecord = await f.db.query<{ n: string }>(
        `select count(*)::text as n from public.bluesky_follow_campaign_members
          where campaign_id = $1 and provider_record_rkey is not null`,
        [c],
      );
      expect(Number(withRecord.rows[0].n)).toBe(N);
    },
    180_000,
  );

  it("paging the queue never uses OFFSET and costs the same at either end", async () => {
    // A keyset page at the far end must be as cheap as one at the
    // start. Compared as PLANS, not as wall-clock — timing is noise on
    // a shared machine, whereas an index scan versus a sequential scan
    // is a fact.
    const c = await f.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaigns
        where name = 'one hundred thousand'`,
    );
    const campaignId = c.rows[0].id;

    const planFor = async (after: number) => {
      const r = await f.db.query<{ "QUERY PLAN": string }>(
        `explain select id from public.bluesky_follow_campaign_members
          where campaign_id = $1 and import_sequence > $2
          order by import_sequence limit 50`,
        [campaignId, after],
      );
      return r.rows.map((x) => x["QUERY PLAN"]).join("\n");
    };

    const early = await planFor(0);
    const late = await planFor(99_000);
    for (const plan of [early, late]) {
      expect(plan).not.toMatch(/Seq Scan/i);
      expect(plan).toMatch(/Index/i);
    }
  });
});

describe("identical timestamps and deterministic tie-breaking", () => {
  it("every source row has the SAME last_discovered_at and none is lost", async () => {
    // The seed above gave all 100,000 rows one identical timestamp.
    // A walk ordered by (timestamp, …) with a weak tie-breaker would
    // repeat or skip rows here; ordering by the DID alone cannot,
    // because the tie-breaker IS the key and a DID never changes.
    const same = await f.db.query<{ n: string }>(
      `select count(distinct last_discovered_at)::text as n
         from public.bluesky_candidates
        where subject_did like 'did:plc:big%'`,
    );
    expect(same.rows[0].n).toBe("1");

    // And the walk is strictly increasing, page over page.
    let cursor: string | null = null;
    let last = "";
    let seen = 0;
    for (let page = 0; page < 6; page += 1) {
      const rows = await listSourcePage({
        workspaceId: f.tenant.workspaceId,
        operatorAccountId: f.tenant.identityId,
        sourceKind: "filtered_candidates",
        targetProfileId: null,
        sourceCampaignId: null,
        afterDid: cursor,
        limit: 500,
        db: f.client,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        expect(row.subjectDid > last).toBe(true);
        last = row.subjectDid;
        seen += 1;
      }
      cursor = rows[rows.length - 1].subjectDid;
    }
    expect(seen).toBe(3000);
  });
});

describe("concurrent queue builders", () => {
  it("duplicate internal work, but never a duplicate member", async () => {
    // ITS OWN IDENTITY, so the source is exactly these 1,500 rows.
    // Sharing the previous test's identity made the source the whole
    // 101,500-row corpus, and the test then measured how far four
    // builders got rather than whether they collided — which is a
    // different question, and a much less interesting one.
    const acct = await f.db.query<{ id: string }>(
      `insert into public.growth_accounts
         (workspace_id, platform, handle, display_name, status)
       values ($1,'bluesky','concurrent.bsky.social','concurrent','active')
       returning id`,
      [f.tenant.workspaceId],
    );
    const identityId = acct.rows[0].id;
    await seedCandidates(1500, "conc", identityId);

    const c = await f.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name, kind, status, created_by)
       values ($1,$2,'concurrent builders','unfollow','draft',$3)
       returning id`,
      [f.tenant.workspaceId, identityId, f.tenant.ownerId],
    ).then((r) => r.rows[0].id);

    const build = () =>
      resumeUnfollowImport({
        workspaceId: f.tenant.workspaceId,
        campaignId: c,
        operatorAccountId: identityId,
        sourceKind: "filtered_candidates",
        targetProfileId: null,
        sourceCampaignId: null,
        db: f.client,
        maxPages: 1,
      });

    // Four builders, overlapping. PGlite serialises them, which is
    // enough for THIS property — the guarantee is a unique constraint,
    // not a lock ordering. Genuine multi-session contention is proven
    // in two-session.pg.test.ts.
    await Promise.all([build(), build(), build(), build()]);
    let progress = await build();
    let guard = 0;
    while (!progress.complete && guard < 50) {
      progress = await build();
      guard += 1;
    }

    const total = await f.db.query<{ n: string; d: string }>(
      `select count(*)::text as n, count(distinct subject_did)::text as d
         from public.bluesky_follow_campaign_members where campaign_id = $1`,
      [c],
    );
    // Every row is a distinct DID: no member was added twice.
    expect(total.rows[0].n).toBe(total.rows[0].d);
    expect(Number(total.rows[0].n)).toBe(1500);

    // And the sequence is still a clean 1..N despite the overlap.
    const seq = await f.db.query<{ n: string; hi: string }>(
      `select count(distinct import_sequence)::text as n,
              max(import_sequence)::text as hi
         from public.bluesky_follow_campaign_members where campaign_id = $1`,
      [c],
    );
    expect(seq.rows[0].n).toBe("1500");
    expect(seq.rows[0].hi).toBe("1500");
  }, 120_000);
});

describe("source immutability", () => {
  it("a campaign refuses a SECOND source once building has begun", async () => {
    const c = await makeUnfollowCampaign(f, "one source only", {
      status: "draft",
    });
    const first = await resumeUnfollowImport({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      operatorAccountId: f.tenant.identityId,
      sourceKind: "filtered_candidates",
      targetProfileId: null,
      sourceCampaignId: null,
      db: f.client,
      maxPages: 1,
    });
    expect(first.error).toBeNull();

    const second = await resumeUnfollowImport({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      operatorAccountId: f.tenant.identityId,
      // A DIFFERENT source for the same campaign.
      sourceKind: "following_records",
      targetProfileId: null,
      sourceCampaignId: null,
      db: f.client,
    });
    expect(second.status).toBe("failed");
    expect(second.error).toMatch(/one source, never a mixture/i);
  });

  it("A RUNNING CAMPAIGN CANNOT SILENTLY WIDEN", async () => {
    // The frozen queue is the whole promise of the confirmation screen:
    // the operator approved "these N people". An import landing after
    // activation would make that sentence false without anyone being
    // asked again.
    const c = await makeUnfollowCampaign(f, "frozen when active", {
      status: "draft",
    });
    await resumeUnfollowImport({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      operatorAccountId: f.tenant.identityId,
      sourceKind: "filtered_candidates",
      targetProfileId: null,
      sourceCampaignId: null,
      db: f.client,
      maxPages: 1,
    });
    const before = await memberCount(c);
    expect(before).toBeGreaterThan(0);

    await f.db.query(
      `update public.bluesky_follow_campaigns set status = 'active' where id = $1`,
      [c],
    );

    const after = await resumeUnfollowImport({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      operatorAccountId: f.tenant.identityId,
      sourceKind: "filtered_candidates",
      targetProfileId: null,
      sourceCampaignId: null,
      db: f.client,
    });
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/already final/i);
    expect(await memberCount(c)).toBe(before);

    // And the RPC itself refuses, not merely the wrapper — so a second
    // call site could not bypass it.
    await expect(
      importUnfollowChunk({
        workspaceId: f.tenant.workspaceId,
        campaignId: c,
        operatorAccountId: f.tenant.identityId,
        actorDid: ACTOR_DID,
        members: [
          {
            subject_did: "did:plc:sneakylateaddition",
            current_handle: null,
            display_name: null,
            record_uri: `at://${ACTOR_DID}/app.bsky.graph.follow/x`,
            record_rkey: "x",
            record_cid: null,
            record_source: "list_records",
          },
        ],
        db: f.client,
      }),
    ).rejects.toThrow(/frozen and cannot take new members/);
  });
});

describe("the acting repository as a source", () => {
  it("walks listRecords by the PROVIDER's cursor and stops only when it says so", async () => {
    const c = await makeUnfollowCampaign(f, "own repo", { status: "draft" });
    const provider = providerDouble({
      listRecordPages: [
        {
          records: [
            {
              uri: `at://${ACTOR_DID}/app.bsky.graph.follow/aaa`,
              cid: "cid-a",
              value: { subject: "did:plc:repo1" },
            },
          ],
          cursor: "page2",
        },
        {
          // A SHORT page that is NOT the end — the provider still hands
          // back a cursor. Inferring the end from page size is how an
          // import silently stops at 40% and calls itself complete.
          records: [
            {
              uri: `at://${ACTOR_DID}/app.bsky.graph.follow/bbb`,
              cid: "cid-b",
              value: { subject: "did:plc:repo2" },
            },
          ],
          cursor: "page3",
        },
        { records: [], cursor: null },
      ],
    });

    const progress = await resumeUnfollowImport({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      operatorAccountId: f.tenant.identityId,
      sourceKind: "following_records",
      targetProfileId: null,
      sourceCampaignId: null,
      db: f.client,
      fetchImpl: provider.fetchImpl,
      sleep: async () => undefined,
    });

    expect(progress.complete).toBe(true);
    expect(await memberCount(c)).toBe(2);

    const rows = await f.db.query<Record<string, string>>(
      `select subject_did, provider_record_rkey, provider_record_cid,
              provider_record_source
         from public.bluesky_follow_campaign_members
        where campaign_id = $1 order by subject_did`,
      [c],
    );
    expect(rows.rows[0].provider_record_rkey).toBe("aaa");
    expect(rows.rows[0].provider_record_cid).toBe("cid-a");
    // The strongest provenance available: read from the acting repo.
    expect(rows.rows[0].provider_record_source).toBe("list_records");
  });

  it("drops a record naming ANOTHER repository instead of queueing it", async () => {
    const c = await makeUnfollowCampaign(f, "foreign record", { status: "draft" });
    const provider = providerDouble({
      listRecordPages: [
        {
          records: [
            {
              uri: "at://did:plc:SOMEONEELSE/app.bsky.graph.follow/zzz",
              value: { subject: "did:plc:foreign" },
            },
            {
              uri: `at://${ACTOR_DID}/app.bsky.graph.follow/ours`,
              value: { subject: "did:plc:ours" },
            },
          ],
          cursor: null,
        },
      ],
    });

    await resumeUnfollowImport({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      operatorAccountId: f.tenant.identityId,
      sourceKind: "following_records",
      targetProfileId: null,
      sourceCampaignId: null,
      db: f.client,
      fetchImpl: provider.fetchImpl,
      sleep: async () => undefined,
    });

    const rows = await f.db.query<{ subject_did: string }>(
      `select subject_did from public.bluesky_follow_campaign_members
        where campaign_id = $1`,
      [c],
    );
    expect(rows.rows.map((r) => r.subject_did)).toEqual(["did:plc:ours"]);
  });

  it("a provider failure keeps the progress already made", async () => {
    const c = await makeUnfollowCampaign(f, "partial then fail", {
      status: "draft",
    });
    let call = 0;
    const provider = providerDouble({});
    provider.fetchImpl = (async (url: RequestInfo | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes("listRecords")) {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              records: [
                {
                  uri: `at://${ACTOR_DID}/app.bsky.graph.follow/kept`,
                  value: { subject: "did:plc:kept" },
                },
              ],
              cursor: "more",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ error: "InternalServerError" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}");
    }) as typeof fetch;

    const progress = await resumeUnfollowImport({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      operatorAccountId: f.tenant.identityId,
      sourceKind: "following_records",
      targetProfileId: null,
      sourceCampaignId: null,
      db: f.client,
      fetchImpl: provider.fetchImpl,
      sleep: async () => undefined,
    });

    expect(progress.status).toBe("failed");
    // The page that DID land is kept — a hiccup at page 40 must not
    // discard 39 pages of work.
    expect(await memberCount(c)).toBe(1);
    // And the campaign is not `ready`, so it cannot be activated.
    const camp = await f.db.query<{ status: string }>(
      `select status from public.bluesky_follow_campaigns where id = $1`, [c]);
    expect(camp.rows[0].status).toBe("failed");
  });
});
