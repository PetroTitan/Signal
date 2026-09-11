import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb, type Row } from "./test-support/fake-db";
import {
  CANDIDATE_PAGE_SIZE,
  countCandidatesByState,
  HISTORY_PAGE_SIZE,
  listActionHistoryPage,
  listCandidatesPage,
} from "@/repositories/bluesky-relationship-repository";
import type { BlueskyRelationshipState } from "@/lib/supabase/types";

/**
 * Pagination over a corpus LARGER than the old 500-row ceiling.
 *
 * The defect being removed: the loader read 500 rows and derived every
 * total from that array. At 4,000 candidates it reported 500, the tab
 * badges were wrong, and rows 501+ were unreachable — silently, because
 * nothing distinguished "500 candidates" from "the first 500 of them".
 */

const WS = "ws-1";
const ID = "acct-1";
const OTHER_WS = "ws-2";
const OTHER_ID = "acct-2";

const STATES: BlueskyRelationshipState[] = [
  "unknown",
  "not_following",
  "following",
  "follows_you",
  "mutual",
];

/** 1,200 candidates — comfortably past the old ceiling. */
const TOTAL = 1_200;

function seed(db: FakeDb, count = TOTAL): void {
  const rows: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      id: `c-${String(i).padStart(5, "0")}`,
      workspace_id: WS,
      operator_account_id: ID,
      subject_did: `did:plc:subject${String(i).padStart(5, "0")}`,
      handle: `follower-${String(i).padStart(5, "0")}.bsky.social`,
      display_name: i % 7 === 0 ? `Designer ${i}` : `Follower ${i}`,
      relationship_state: STATES[i % STATES.length],
      protected: i % 100 === 0,
      // Deliberately IDENTICAL for every row: real imports write a page
      // of rows within the same millisecond, and an unstable sort is
      // what makes a row appear on two pages and on none.
      last_discovered_at: "2026-09-01T00:00:00.000Z",
      follow_rkey: null,
      follow_cid: null,
    });
  }
  db.tables.set("bluesky_candidates", rows);
  db.tables.set("bluesky_candidate_sources", []);
}

describe("listCandidatesPage — exact totals beyond the old ceiling", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    seed(db);
  });

  it("reports the EXACT total, not the page length or a capped estimate", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    expect(page.total).toBe(TOTAL);
    // The bug this replaces would have produced 500 here.
    expect(page.total).not.toBe(page.rows.length);
    expect(page.total).not.toBe(500);
    expect(page.rows.length).toBe(CANDIDATE_PAGE_SIZE);
    expect(page.totalPages).toBe(Math.ceil(TOTAL / CANDIDATE_PAGE_SIZE));
  });

  it("navigates to the last page and returns the final rows", async () => {
    const first = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    const last = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      page: first.totalPages,
      db: db.client(),
    });
    expect(last.rows.length).toBeGreaterThan(0);
    expect(last.page).toBe(first.totalPages);
    // Rows 501+ were unreachable before; they are reachable now.
    expect(last.rows[0].id).not.toBe(first.rows[0].id);
  });

  it("walks every page exactly once — no row seen twice, none missed", async () => {
    // The tiebreaker matters here: every seeded row shares
    // last_discovered_at to the millisecond.
    const seen: string[] = [];
    const first = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    for (let p = 1; p <= first.totalPages; p += 1) {
      const page = await listCandidatesPage({
        workspaceId: WS,
        operatorAccountId: ID,
        page: p,
        db: db.client(),
      });
      seen.push(...page.rows.map((r) => r.id));
    }
    expect(seen.length).toBe(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("clamps an out-of-range page rather than erroring", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      page: 99_999,
      db: db.client(),
    });
    expect(page.total).toBe(TOTAL);
    expect(page.rows).toEqual([]);
    const negative = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      page: -5,
      db: db.client(),
    });
    expect(negative.page).toBe(1);
  });

  it("caps an oversized pageSize so one request cannot pull the table", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      pageSize: 10_000,
      db: db.client(),
    });
    expect(page.rows.length).toBeLessThanOrEqual(200);
  });
});

describe("filtering and search narrow BOTH the rows and the total", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    seed(db);
  });

  it("a state filter yields a total matching the filtered set", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      states: ["following"],
      db: db.client(),
    });
    // Every 5th row is "following".
    expect(page.total).toBe(TOTAL / STATES.length);
    for (const row of page.rows) expect(row.relationship_state).toBe("following");
  });

  it("a search narrows the total, not just the visible rows", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      search: "Designer",
      db: db.client(),
    });
    const expected = Math.ceil(TOTAL / 7);
    expect(page.total).toBe(expected);
    expect(page.total).toBeLessThan(TOTAL);
  });

  it("search matches handle as well as display name", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      search: "follower-00042",
      db: db.client(),
    });
    expect(page.total).toBe(1);
    expect(page.rows[0].handle).toContain("follower-00042");
  });

  it("a search matching nothing is an empty page with a zero total", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      search: "zzzz-no-such-account",
      db: db.client(),
    });
    expect(page.total).toBe(0);
    expect(page.rows).toEqual([]);
    expect(page.totalPages).toBe(1);
  });

  it("protectedOnly narrows to exactly the protected rows", async () => {
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      protectedOnly: true,
      db: db.client(),
    });
    expect(page.total).toBe(TOTAL / 100);
    for (const row of page.rows) expect(row.protected).toBe(true);
  });
});

describe("countCandidatesByState — exact, and consistent with the pages", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
    seed(db);
  });

  it("per-state counts sum to the total", async () => {
    const counts = await countCandidatesByState({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    expect(counts.total).toBe(TOTAL);
    const sum =
      counts.unknown +
      counts.not_following +
      counts.following +
      counts.follows_you +
      counts.mutual;
    expect(sum).toBe(TOTAL);
    expect(counts.protectedCount).toBe(TOTAL / 100);
  });

  it("each count equals the paginated total for that state", async () => {
    const counts = await countCandidatesByState({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    for (const state of STATES) {
      const page = await listCandidatesPage({
        workspaceId: WS,
        operatorAccountId: ID,
        states: [state],
        db: db.client(),
      });
      expect(page.total, state).toBe(counts[state]);
    }
  });

  it("a search narrows the counts too, so a badge never outruns its list", async () => {
    const counts = await countCandidatesByState({
      workspaceId: WS,
      operatorAccountId: ID,
      search: "Designer",
      db: db.client(),
    });
    expect(counts.total).toBe(Math.ceil(TOTAL / 7));
    expect(counts.total).toBeLessThan(TOTAL);
  });
});

describe("workspace and operator scope survive pagination", () => {
  it("another workspace's rows are never returned or counted", async () => {
    const db = new FakeDb();
    seed(db, 100);
    // Same-shaped rows belonging to a different workspace AND a
    // different identity in this workspace.
    db.rows("bluesky_candidates").push(
      {
        id: "x1", workspace_id: OTHER_WS, operator_account_id: ID,
        subject_did: "did:plc:foreign", handle: "foreign.bsky.social",
        display_name: "Designer foreign", relationship_state: "following",
        protected: false, last_discovered_at: "2026-09-02T00:00:00.000Z",
      },
      {
        id: "x2", workspace_id: WS, operator_account_id: OTHER_ID,
        subject_did: "did:plc:otheridentity", handle: "other.bsky.social",
        display_name: "Designer other", relationship_state: "following",
        protected: false, last_discovered_at: "2026-09-02T00:00:00.000Z",
      },
    );

    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    expect(page.total).toBe(100);
    const ids = page.rows.map((r) => r.id);
    expect(ids).not.toContain("x1");
    expect(ids).not.toContain("x2");

    const counts = await countCandidatesByState({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    expect(counts.total).toBe(100);

    // Even a search that would match them across the boundary.
    const searched = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      search: "Designer",
      db: db.client(),
    });
    expect(searched.rows.map((r) => r.id)).not.toContain("x1");
    expect(searched.rows.map((r) => r.id)).not.toContain("x2");
  });
});

describe("overlapping source attribution stays deduplicated across pages", () => {
  it("a candidate found under three targets shows three ids, once each", async () => {
    const db = new FakeDb();
    seed(db, 60);
    const candidateId = db.rows("bluesky_candidates")[0].id as string;
    db.tables.set(
      "bluesky_candidate_sources",
      ["t1", "t2", "t3"].map((t, i) => ({
        id: `s${i}`,
        workspace_id: WS,
        candidate_id: candidateId,
        target_profile_id: t,
      })),
    );

    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    const row = page.rows.find((r) => r.id === candidateId)!;
    expect(row.sourceTargetProfileIds.sort()).toEqual(["t1", "t2", "t3"]);
    // One row, not three.
    expect(page.rows.filter((r) => r.id === candidateId)).toHaveLength(1);
    expect(page.total).toBe(60);
  });

  it("filtering by target keeps the candidate's OTHER attributions visible", async () => {
    const db = new FakeDb();
    seed(db, 10);
    const candidateId = db.rows("bluesky_candidates")[0].id as string;
    db.tables.set(
      "bluesky_candidate_sources",
      ["t1", "t2"].map((t, i) => ({
        id: `s${i}`, workspace_id: WS, candidate_id: candidateId, target_profile_id: t,
      })),
    );
    const page = await listCandidatesPage({
      workspaceId: WS,
      operatorAccountId: ID,
      targetProfileId: "t1",
      db: db.client(),
    });
    const row = page.rows.find((r) => r.id === candidateId)!;
    expect(row.sourceTargetProfileIds.sort()).toEqual(["t1", "t2"]);
  });
});

describe("listActionHistoryPage", () => {
  const HISTORY = 400;
  let db: FakeDb;

  beforeEach(() => {
    db = new FakeDb();
    const rows: Row[] = [];
    for (let i = 0; i < HISTORY; i += 1) {
      rows.push({
        id: `a-${String(i).padStart(4, "0")}`,
        workspace_id: WS,
        operator_account_id: ID,
        action_type: i % 2 === 0 ? "follow" : "unfollow",
        status: "succeeded",
        subject_did: `did:plc:subject${i % 50}`,
        subject_handle_at_action: `h${i}.bsky.social`,
        // Identical instants again: batches write many rows at once.
        requested_at: "2026-09-01T00:00:00.000Z",
        source_target_profile_ids: [],
      });
    }
    db.tables.set("bluesky_relationship_actions", rows);
  });

  it("reports the exact total and pages through all of it", async () => {
    const first = await listActionHistoryPage({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    expect(first.total).toBe(HISTORY);
    expect(first.rows.length).toBe(HISTORY_PAGE_SIZE);

    const seen: string[] = [];
    for (let p = 1; p <= first.totalPages; p += 1) {
      const page = await listActionHistoryPage({
        workspaceId: WS,
        operatorAccountId: ID,
        page: p,
        db: db.client(),
      });
      seen.push(...page.rows.map((r) => r.id));
    }
    expect(seen.length).toBe(HISTORY);
    expect(new Set(seen).size).toBe(HISTORY);
  });

  it("narrowing to one DID narrows the total", async () => {
    const page = await listActionHistoryPage({
      workspaceId: WS,
      operatorAccountId: ID,
      subjectDid: "did:plc:subject7",
      db: db.client(),
    });
    expect(page.total).toBe(HISTORY / 50);
    for (const row of page.rows) expect(row.subject_did).toBe("did:plc:subject7");
  });

  it("stays scoped to the workspace and identity", async () => {
    db.rows("bluesky_relationship_actions").push({
      id: "foreign", workspace_id: OTHER_WS, operator_account_id: ID,
      action_type: "follow", status: "succeeded", subject_did: "did:plc:x",
      requested_at: "2026-09-09T00:00:00.000Z", source_target_profile_ids: [],
    });
    const page = await listActionHistoryPage({
      workspaceId: WS,
      operatorAccountId: ID,
      db: db.client(),
    });
    expect(page.total).toBe(HISTORY);
    expect(page.rows.map((r) => r.id)).not.toContain("foreign");
  });
});
