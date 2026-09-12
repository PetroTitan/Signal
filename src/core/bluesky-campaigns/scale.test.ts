import { beforeAll, describe, expect, it } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import {
  claimMembers,
  countMembersByStatus,
  importMemberChunk,
  listMembersPage,
  nextImportSequence,
  releaseMembers,
  CAMPAIGN_MEMBER_PAGE_SIZE,
  IMPORT_CHUNK_SIZE,
} from "@/repositories/bluesky-campaign-repository";

/**
 * 100,000-member scale.
 *
 * The requirement is a queue with no application-level maximum, so the
 * number that matters is not "does 3,000 work" but "does anything in
 * the design get slower, lossy or ambiguous at 100,000". Three things
 * could:
 *
 *   - an in-memory dedupe set (would only dedupe within one call);
 *   - OFFSET paging (degrades linearly, and skips rows when earlier
 *     ones change status between calls);
 *   - ordering on a timestamp (a bulk import writes thousands of rows
 *     inside one millisecond, so ties are undefined between requests).
 *
 * Each is tested here against a corpus that would expose it.
 */

const WS = "ws-1";
const CAMPAIGN = "camp-1";
const TOTAL = 100_000;

/** Built once — 100k rows through the import path is the slow part. */
let db: FakeDb;

function seedLocalCampaign(local: FakeDb): void {
  local.tables.set("bluesky_follow_campaigns", [
    { id: CAMPAIGN, workspace_id: WS, status: "draft" },
  ]);
}

async function seedViaImport(): Promise<void> {
  db = new FakeDb();
  seedLocalCampaign(db);
  let sequence = await nextImportSequence(WS, CAMPAIGN, db.client());
  for (let offset = 0; offset < TOTAL; offset += IMPORT_CHUNK_SIZE) {
    const members = [];
    for (let i = offset; i < Math.min(offset + IMPORT_CHUNK_SIZE, TOTAL); i += 1) {
      members.push({
        subjectDid: `did:plc:member${String(i).padStart(6, "0")}`,
        currentHandle: `follower-${i}.bsky.social`,
        displayName: i % 1000 === 0 ? `Notable ${i}` : `Follower ${i}`,
      });
    }
    const result = await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members,
      startSequence: sequence,
      db: db.client(),
    });
    sequence = result.lastSequence + 1;
  }
}

beforeAll(async () => {
  await seedViaImport();
}, 300_000);

describe("importing 100,000 members", () => {
  it("stores exactly 100,000 rows with no loss and no duplication", () => {
    const rows = db.rows("bluesky_follow_campaign_members");
    expect(rows).toHaveLength(TOTAL);
    expect(new Set(rows.map((r) => r.subject_did)).size).toBe(TOTAL);
  });

  it("assigns a dense, unique, monotonic import_sequence", () => {
    // Unique because it is the ordering key; dense because a gap would
    // mean a chunk silently lost rows.
    const seqs = db
      .rows("bluesky_follow_campaign_members")
      .map((r) => Number(r.import_sequence));
    expect(new Set(seqs).size).toBe(TOTAL);
    expect(Math.min(...seqs)).toBe(1);
    expect(Math.max(...seqs)).toBe(TOTAL);
  });

  it("reports exact counts, not page-derived ones", async () => {
    const counts = await countMembersByStatus({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      db: db.client(),
    });
    expect(counts.total).toBe(TOTAL);
    expect(counts.queued).toBe(TOTAL);
    expect(counts.remainingEligible).toBe(TOTAL);
    // A page-derived total would have produced 50.
    expect(counts.total).not.toBe(CAMPAIGN_MEMBER_PAGE_SIZE);
  });

  it("keeps every member's DID as identity — never a handle", () => {
    for (const r of db.rows("bluesky_follow_campaign_members").slice(0, 200)) {
      expect(String(r.subject_did)).toMatch(/^did:/);
    }
  });
}, 300_000);

describe("paginating 100,000 members", () => {
  it("walks every page exactly once — no row twice, none missed", async () => {
    // 200 is the repository's hard cap — one request can never pull an
    // unbounded slice of a 100,000-row queue, however large a pageSize
    // a caller asks for.
    const oversized = await listMembersPage({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      pageSize: 100_000,
      db: db.client(),
    });
    expect(oversized.rows.length).toBeLessThanOrEqual(200);

    const first = await listMembersPage({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      pageSize: 200,
      db: db.client(),
    });
    expect(first.info.total).toBe(TOTAL);
    expect(first.info.totalPages).toBe(500);

    const seen = new Set<string>();
    for (let p = 1; p <= first.info.totalPages; p += 1) {
      const page = await listMembersPage({
        workspaceId: WS,
        campaignId: CAMPAIGN,
        page: p,
        pageSize: 200,
        db: db.client(),
      });
      for (const row of page.rows) seen.add(String(row.id));
    }
    expect(seen.size).toBe(TOTAL);
  }, 300_000);

  it("orders by import_sequence, which is total — not by a tied timestamp", async () => {
    // Every one of the 100k rows was written inside the same test run;
    // `created_at` ties in huge blocks. An order on it would leave the
    // sort undefined and pages would overlap.
    const created = new Set(
      db.rows("bluesky_follow_campaign_members").slice(0, 5000).map((r) => r.created_at),
    );
    expect(created.size).toBeLessThan(5000);

    const page = await listMembersPage({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      page: 40,
      pageSize: 200,
      db: db.client(),
    });
    const seqs = page.rows.map((r) => Number(r.import_sequence));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    // Page 40 at 200 per page starts at sequence 7,801 — and it is
    // NUMERICALLY ordered. A lexicographic sort would have put 17,017
    // before 1,702 here, which is what the first version of the fake
    // did and what this assertion now pins.
    expect(seqs[0]).toBe(7_801);
    expect(seqs[199]).toBe(8_000);
  });

  it("reaches the final page — rows past any fixed ceiling are addressable", async () => {
    const last = await listMembersPage({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      page: 2000,
      pageSize: 50,
      db: db.client(),
    });
    expect(last.rows).toHaveLength(50);
    expect(Number(last.rows[49].import_sequence)).toBe(TOTAL);
  });

  it("filters and counts consistently", async () => {
    const page = await listMembersPage({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      search: "Notable",
      pageSize: 50,
      db: db.client(),
    });
    expect(page.info.total).toBe(TOTAL / 1000);
    expect(page.info.total).toBeLessThan(TOTAL);
  });
}, 300_000);

describe("re-importing an overlapping audience", () => {
  it("creates no duplicates and does not reshuffle the queue", async () => {
    const local = new FakeDb();
    seedLocalCampaign(local);
    const members = Array.from({ length: 1000 }, (_, i) => ({
      subjectDid: `did:plc:x${i}`,
      currentHandle: `x${i}.bsky.social`,
      displayName: null,
    }));

    const first = await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members,
      startSequence: 1,
      db: local.client(),
    });
    expect(first.inserted).toBe(1000);

    // Mark some progress, then re-import the SAME audience plus 200 new.
    const rows = local.rows("bluesky_follow_campaign_members");
    rows[0].status = "succeeded";
    rows[0].provider_record_rkey = "3keepme";
    const originalSequence = rows[0].import_sequence;

    const second = await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members: [
        ...members,
        ...Array.from({ length: 200 }, (_, i) => ({
          subjectDid: `did:plc:new${i}`,
          currentHandle: null,
          displayName: null,
        })),
      ],
      startSequence: 1001,
      db: local.client(),
    });

    expect(second.inserted).toBe(200);
    expect(second.duplicates).toBe(1000);
    expect(local.rows("bluesky_follow_campaign_members")).toHaveLength(1200);

    // The already-present member kept its sequence AND its progress —
    // re-importing must never reshuffle a running queue.
    const kept = local
      .rows("bluesky_follow_campaign_members")
      .find((r) => r.subject_did === "did:plc:x0")!;
    expect(kept.import_sequence).toBe(originalSequence);
    expect(kept.status).toBe("succeeded");
    expect(kept.provider_record_rkey).toBe("3keepme");
  });

  it("collapses duplicates WITHIN one chunk without burning sequences", async () => {
    const local = new FakeDb();
    seedLocalCampaign(local);
    const result = await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members: [
        { subjectDid: "did:plc:dup", currentHandle: "a", displayName: null },
        { subjectDid: "did:plc:dup", currentHandle: "b", displayName: null },
        { subjectDid: "did:plc:other", currentHandle: "c", displayName: null },
      ],
      startSequence: 1,
      db: local.client(),
    });
    expect(result.inserted).toBe(2);
    expect(local.rows("bluesky_follow_campaign_members")).toHaveLength(2);
    const seqs = local
      .rows("bluesky_follow_campaign_members")
      .map((r) => Number(r.import_sequence));
    expect(seqs.sort()).toEqual([1, 2]);
  });

  it("rejects anything that is not a DID", async () => {
    const local = new FakeDb();
    seedLocalCampaign(local);
    const result = await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members: [
        { subjectDid: "someone.bsky.social", currentHandle: null, displayName: null },
        { subjectDid: "did:plc:valid", currentHandle: null, displayName: null },
      ],
      startSequence: 1,
      db: local.client(),
    });
    expect(result.inserted).toBe(1);
    expect(local.rows("bluesky_follow_campaign_members")[0].subject_did).toBe(
      "did:plc:valid",
    );
  });
});

describe("the same DID from multiple sources", () => {
  it("is one member with attribution from each source", async () => {
    const local = new FakeDb();
    seedLocalCampaign(local);
    await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members: [
        {
          subjectDid: "did:plc:shared",
          currentHandle: "shared.bsky.social",
          displayName: null,
          targetProfileId: "target-a",
          sourceLabel: "target_followers",
        },
      ],
      startSequence: 1,
      db: local.client(),
    });
    await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members: [
        {
          subjectDid: "did:plc:shared",
          currentHandle: "renamed.bsky.social",
          displayName: null,
          targetProfileId: "target-b",
          sourceLabel: "target_followers",
        },
      ],
      startSequence: 2,
      db: local.client(),
    });

    expect(local.rows("bluesky_follow_campaign_members")).toHaveLength(1);
    const sources = local.rows("bluesky_campaign_member_sources");
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((s) => s.target_profile_id))).toEqual(
      new Set(["target-a", "target-b"]),
    );
  });

  it("a changed handle updates nothing that matters and loses no history", async () => {
    const local = new FakeDb();
    seedLocalCampaign(local);
    await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members: [
        { subjectDid: "did:plc:renamed", currentHandle: "old.bsky.social", displayName: null },
      ],
      startSequence: 1,
      db: local.client(),
    });
    const row = local.rows("bluesky_follow_campaign_members")[0];
    row.status = "succeeded";
    row.provider_record_rkey = "3done";

    // Same DID, new handle.
    await importMemberChunk({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      members: [
        { subjectDid: "did:plc:renamed", currentHandle: "brand-new.bsky.social", displayName: null },
      ],
      startSequence: 2,
      db: local.client(),
    });

    expect(local.rows("bluesky_follow_campaign_members")).toHaveLength(1);
    const after = local.rows("bluesky_follow_campaign_members")[0];
    expect(after.status).toBe("succeeded");
    expect(after.provider_record_rkey).toBe("3done");
  });
});

describe("claiming at 100,000 rows", () => {
  it("claims from the FRONT of the queue regardless of depth", async () => {
    const local = new FakeDb();
    const rows: Row[] = [];
    for (let i = 1; i <= 50_000; i += 1) {
      rows.push({
        id: `m${i}`,
        workspace_id: WS,
        campaign_id: CAMPAIGN,
        subject_did: `did:plc:m${i}`,
        import_sequence: i,
        status: i <= 30_000 ? "succeeded" : "queued",
        attempt_count: 0,
        next_attempt_at: null,
        lease_expires_at: null,
      });
    }
    local.tables.set("bluesky_follow_campaign_members", rows);

    const claimed = await claimMembers({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      chunkSize: 20,
      leaseSeconds: 300,
      claimedBy: "worker-1",
      db: local.client(),
    });

    expect(claimed).toHaveLength(20);
    // The first claimable row is sequence 30,001 — reached by ordering,
    // not by an OFFSET that would have to skip 30,000 rows.
    expect(Number(claimed[0].import_sequence)).toBe(30_001);
    expect(Number(claimed[19].import_sequence)).toBe(30_020);
  });

  it("releases untouched rows without spending an attempt", async () => {
    const local = new FakeDb();
    local.tables.set("bluesky_follow_campaign_members", [
      {
        id: "m1", workspace_id: WS, campaign_id: CAMPAIGN,
        subject_did: "did:plc:1", import_sequence: 1, status: "queued",
        attempt_count: 0, next_attempt_at: null, lease_expires_at: null,
      },
    ]);
    const claimed = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 5,
      leaseSeconds: 300, claimedBy: "w", db: local.client(),
    });
    expect(claimed).toHaveLength(1);

    const released = await releaseMembers({
      workspaceId: WS, campaignId: CAMPAIGN,
      memberIds: claimed.map((c) => c.id), db: local.client(),
    });
    expect(released).toBe(1);

    const row = local.rows("bluesky_follow_campaign_members")[0];
    expect(row.status).toBe("queued");
    expect(row.lease_expires_at).toBeNull();
    // Never attempted, never penalised.
    expect(row.attempt_count).toBe(0);
  });
});
