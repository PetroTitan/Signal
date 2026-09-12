import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import {
  resumeCampaignImport,
  DEFAULT_MAX_WINDOWS,
} from "./resume-import.server";
import { getImportJob } from "@/repositories/bluesky-campaign-import-repository";

/**
 * Building a queue larger than one invocation can hold.
 *
 * The old import walked the corpus with OFFSET, stopped after 20 pages
 * of 500, and returned a `nextPage` for the caller to hand back. The UI
 * never did, so every invocation started at page 1: a corpus past
 * ~10,000 could never finish. The same first rows imported over and
 * over while the rest was never reached.
 *
 * These tests are about the two properties that failure violated —
 * progress survives the invocation, and the walk is stable — measured
 * on a corpus big enough that neither can be faked.
 */

const WS = "ws-1";
const IDENTITY = "acct-1";
const CAMPAIGN = "camp-1";

/** Big enough that ~10,000 is visibly not the end. */
const LARGE_CORPUS = 100_000;

function seedCampaign(db: FakeDb): void {
  db.tables.set("bluesky_follow_campaigns", [
    {
      id: CAMPAIGN,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      name: "scale",
      status: "draft",
      requested_daily_quota: 300,
      timezone: "UTC",
      execution_window_start_minute: 0,
      execution_window_end_minute: 1440,
      start_date: null,
      dry_run: false,
      max_consecutive_failures: 5,
      min_success_rate_percent: 50,
      next_run_at: null,
      rate_limited_until: null,
      completed_at: null,
      created_by: "user-1",
    },
  ]);
  db.tables.set("bluesky_follow_campaign_members", []);
  db.tables.set("bluesky_campaign_import_jobs", []);
  db.tables.set("bluesky_candidate_sources", []);
}

/**
 * A corpus whose timestamps repeat deliberately.
 *
 * Every 7th candidate shares a `last_discovered_at` with its
 * neighbours, so the order is only total because the DID breaks the
 * tie. A walk without that tie-breaker skips and repeats rows here.
 */
function seedCandidates(
  db: FakeDb,
  count: number,
  opts: { protectedEvery?: number; targetId?: string } = {},
): void {
  const rows: Row[] = [];
  const sources: Row[] = [];
  const base = Date.parse("2026-09-01T00:00:00Z");
  for (let i = 0; i < count; i += 1) {
    const id = `cand-${i}`;
    // Deliberate collisions: seven consecutive rows share a timestamp.
    const bucket = Math.floor(i / 7);
    rows.push({
      id,
      workspace_id: WS,
      operator_account_id: IDENTITY,
      subject_did: `did:plc:${String(i).padStart(7, "0")}`,
      handle: `h${i}.bsky.social`,
      display_name: null,
      relationship_state: "not_following",
      protected:
        opts.protectedEvery !== undefined && i % opts.protectedEvery === 0,
      first_discovered_at: new Date(base + bucket * 1000).toISOString(),
      last_discovered_at: new Date(base + bucket * 1000).toISOString(),
    });
    if (opts.targetId) {
      sources.push({
        id: `src-${i}`,
        workspace_id: WS,
        candidate_id: id,
        target_profile_id: opts.targetId,
      });
    }
  }
  db.tables.set("bluesky_candidates", rows);
  if (opts.targetId) {
    const existing = db.tables.get("bluesky_candidate_sources") ?? [];
    db.tables.set("bluesky_candidate_sources", [...existing, ...sources]);
  }
}

const importOnce = (db: FakeDb, over: Record<string, unknown> = {}) =>
  resumeCampaignImport({
    workspaceId: WS,
    operatorAccountId: IDENTITY,
    campaignId: CAMPAIGN,
    sourceKind: "candidates",
    targetProfileId: null,
    db: db.client(),
    ...over,
  });

const queued = (db: FakeDb) => db.rows("bluesky_follow_campaign_members");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a corpus larger than one invocation", () => {
  it("imports all 100,000 across repeated invocations", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, LARGE_CORPUS);

    let calls = 0;
    let result = await importOnce(db);
    calls += 1;

    // Each invocation is bounded, so this takes many of them. The point
    // is that it TERMINATES, and at the right number.
    while (!result.complete && calls < 500) {
      result = await importOnce(db);
      calls += 1;
    }

    expect(result.complete).toBe(true);
    expect(queued(db)).toHaveLength(LARGE_CORPUS);

    // Every DID exactly once.
    const dids = new Set(queued(db).map((m) => String(m.subject_did)));
    expect(dids.size).toBe(LARGE_CORPUS);

    // And it really did take more than one invocation — a test that
    // finished in one would prove nothing about resumability.
    expect(calls).toBeGreaterThan(1);
  }, 300_000);

  it("the SECOND invocation does not restart at the beginning", async () => {
    // The exact defect: `nextPage` was returned to a caller that never
    // sent it back, so invocation two re-walked invocation one's rows
    // and the corpus past ~10,000 was unreachable.
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 30_000);

    const first = await importOnce(db);
    expect(first.complete).toBe(false);
    const afterFirst = queued(db).length;
    expect(afterFirst).toBe(DEFAULT_MAX_WINDOWS * 500);

    const second = await importOnce(db);

    // It moved on. Re-walking would have imported zero new members and
    // counted 10,000 duplicates.
    expect(second.imported).toBeGreaterThan(0);
    expect(queued(db).length).toBe(afterFirst + second.imported);
    expect(second.duplicates).toBe(0);

    // The checkpoint is in the database, not in the caller's hands.
    const job = await getImportJob({
      workspaceId: WS,
      campaignId: CAMPAIGN,
      db: db.client(),
    });
    expect(job?.cursorSubjectDid).toBeTruthy();
    expect(job?.importedCount).toBe(queued(db).length);
  }, 300_000);

  it("resumes from durable progress after a crash mid-import", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 20_000);

    await importOnce(db);
    const survived = queued(db).length;
    expect(survived).toBeGreaterThan(0);

    // The process dies. Nothing is handed to the next one but the
    // database.
    const revived = new FakeDb();
    for (const [table, rows] of db.tables) revived.tables.set(table, rows);

    let result = await importOnce(revived);
    let guard = 0;
    while (!result.complete && guard < 100) {
      result = await importOnce(revived);
      guard += 1;
    }

    expect(result.complete).toBe(true);
    expect(queued(revived)).toHaveLength(20_000);
    const dids = new Set(queued(revived).map((m) => String(m.subject_did)));
    expect(dids.size).toBe(20_000);
  }, 300_000);

  it("concurrent imports duplicate no member and skip none", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 12_000);

    // Four callers at once, repeatedly, as a double-submitted button or
    // an overlapping retry would produce.
    for (let round = 0; round < 12; round += 1) {
      await Promise.all([
        importOnce(db),
        importOnce(db),
        importOnce(db),
        importOnce(db),
      ]);
      const job = await getImportJob({
        workspaceId: WS,
        campaignId: CAMPAIGN,
        db: db.client(),
      });
      if (job?.sourceExhausted) break;
    }

    const members = queued(db);
    const dids = new Set(members.map((m) => String(m.subject_did)));
    expect(dids.size).toBe(members.length);
    expect(members).toHaveLength(12_000);

    // Sequences are unique too — nothing was written twice under a
    // different position.
    const seqs = members.map((m) => Number(m.import_sequence));
    expect(new Set(seqs).size).toBe(seqs.length);
  }, 300_000);

  it("rediscovery cannot move an unseen candidate behind the checkpoint", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 800);

    const first = await importOnce(db, { maxWindows: 1 });
    expect(first.imported).toBe(500);

    const unseen = db
      .rows("bluesky_candidates")
      .find((c) => c.subject_did === "did:plc:0000700");
    expect(unseen).toBeTruthy();
    // This column is deliberately mutable on every re-import. It must
    // not be the campaign checkpoint.
    unseen!.last_discovered_at = "2099-01-01T00:00:00.000Z";

    let result = await importOnce(db);
    while (!result.complete) result = await importOnce(db);

    expect(queued(db)).toHaveLength(800);
    expect(
      queued(db).some((m) => m.subject_did === "did:plc:0000700"),
    ).toBe(true);
  });

  it("freezes a finite source when the import job begins", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 600);

    await importOnce(db, { maxWindows: 1 });
    db.rows("bluesky_candidates").push({
      id: "late",
      workspace_id: WS,
      operator_account_id: IDENTITY,
      subject_did: "did:plc:late",
      relationship_state: "not_following",
      protected: false,
      first_discovered_at: "2099-01-01T00:00:00.000Z",
      last_discovered_at: "2099-01-01T00:00:00.000Z",
    });

    let result = await importOnce(db);
    while (!result.complete) result = await importOnce(db);

    expect(queued(db)).toHaveLength(600);
    expect(queued(db).some((m) => m.subject_did === "did:plc:late")).toBe(false);
  });

  it("repeating an invocation after completion changes nothing", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 400);

    const first = await importOnce(db);
    expect(first.complete).toBe(true);
    expect(queued(db)).toHaveLength(400);

    const again = await importOnce(db);
    expect(again.complete).toBe(true);
    expect(again.imported).toBe(0);
    expect(queued(db)).toHaveLength(400);
  }, 120_000);
});

describe("what the queue excludes", () => {
  it("never queues a protected profile", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 1_000, { protectedEvery: 10 });

    let result = await importOnce(db);
    let guard = 0;
    while (!result.complete && guard < 50) {
      result = await importOnce(db);
      guard += 1;
    }

    expect(result.complete).toBe(true);
    expect(queued(db)).toHaveLength(900);
    expect(result.excluded).toBe(100);
  }, 120_000);

  it("a 449-profile corpus queues exactly 449", async () => {
    // The size an operator actually had. It must not be rounded to a
    // page boundary in either direction.
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 449);

    const result = await importOnce(db);
    expect(result.complete).toBe(true);
    expect(result.imported).toBe(449);
    expect(queued(db)).toHaveLength(449);
  }, 120_000);
});

describe("source selection", () => {
  it("does not mix candidates from an unrelated imported list", async () => {
    const db = new FakeDb();
    seedCampaign(db);

    // Two lists, imported from two different profiles.
    seedCandidates(db, 300, { targetId: "target-A" });
    const a = db.rows("bluesky_candidates").map((c) => ({ ...c }));
    const aSources = db.rows("bluesky_candidate_sources").map((s) => ({ ...s }));
    seedCandidates(db, 200, { targetId: "target-B" });
    const b = db.rows("bluesky_candidates").map((c, i) => ({
      ...c,
      id: `b-${i}`,
      subject_did: `did:plc:b${String(i).padStart(6, "0")}`,
    }));
    const bSources = db.rows("bluesky_candidate_sources").map((s, i) => ({
      ...s,
      id: `bsrc-${i}`,
      candidate_id: `b-${i}`,
      target_profile_id: "target-B",
    }));
    db.tables.set("bluesky_candidates", [...a, ...b]);
    db.tables.set("bluesky_candidate_sources", [...aSources, ...bSources]);

    let result = await importOnce(db, {
      sourceKind: "candidates",
      targetProfileId: "target-A",
    });
    let guard = 0;
    while (!result.complete && guard < 50) {
      result = await importOnce(db, {
        sourceKind: "candidates",
        targetProfileId: "target-A",
      });
      guard += 1;
    }

    expect(result.complete).toBe(true);
    // Only list A. Not 500.
    expect(queued(db)).toHaveLength(300);
    for (const m of queued(db)) {
      expect(String(m.subject_did).startsWith("did:plc:b")).toBe(false);
    }
  }, 120_000);

  it("refuses to rebuild an existing queue from a different list", async () => {
    const db = new FakeDb();
    seedCampaign(db);
    seedCandidates(db, 100, { targetId: "target-A" });

    await importOnce(db, { targetProfileId: "target-A" });
    const mixed = await importOnce(db, { targetProfileId: "target-B" });

    expect(mixed.refusedReason).toBe("source_mismatch");
    expect(mixed.status).toBe("failed");
    expect(mixed.imported).toBe(0);
  }, 120_000);
});
