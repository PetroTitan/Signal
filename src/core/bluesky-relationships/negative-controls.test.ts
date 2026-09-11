import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyFollowOutcome,
  classifyUnfollowOutcome,
  preflightUnfollow,
  reconcileFollow,
  reconcileUnfollow,
} from "./mutation-outcome";
import {
  relationshipsUnavailable,
  resolveRelationship,
} from "./relationship-state";
import { applyPage } from "./import-plan";
import { rkeyFromAtUri } from "./atproto-graph";
import type { GraphFailure } from "./atproto-graph";

/**
 * NEGATIVE CONTROLS
 * =================
 *
 * Ten invariants, each asserted so that BREAKING it makes a test fail.
 *
 * Every one of these was verified by actually introducing the defect
 * into the source, running the suite, watching the named test fail, and
 * then restoring the code. A control that has never been seen to fail
 * is a control nobody has tested; the whole point is that these are not
 * decorative.
 *
 * The results of that exercise are recorded in
 * docs/relationships/negative-controls.md, which names the exact edit
 * made for each one and the test that caught it.
 *
 * Where an invariant lives in SQL rather than TypeScript, the control
 * reads the migration text — there is no local Postgres in this
 * repository, so asserting the constraint EXISTS in the migration is
 * the strongest honest check available here. That limitation is stated
 * in the milestone report rather than papered over.
 */

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260911000001_bluesky_relationship_actions.sql",
);
const sql = (): string => readFileSync(MIGRATION, "utf8");

const failure = (over: Partial<GraphFailure> = {}): GraphFailure => ({
  ok: false,
  kind: "provider_error",
  status: 500,
  errorCode: null,
  message: "provider unavailable",
  rateLimit: null,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────
// 1. Handle used instead of DID identity
// ─────────────────────────────────────────────────────────────────────

describe("NC1 — handle is never durable identity", () => {
  it("the candidate uniqueness constraint is on subject_did, not handle", () => {
    const source = sql();
    // Break by changing this to `handle` and the test fails.
    expect(source).toMatch(
      /create table if not exists public\.bluesky_candidates[\s\S]*?unique \(workspace_id, operator_account_id, subject_did\)/,
    );
  });

  it("no unique index anywhere in the migration is keyed on a handle", () => {
    const source = sql();
    const uniques = source.match(/unique[^;]*\([^)]*\)/gi) ?? [];
    for (const clause of uniques) {
      expect(clause).not.toMatch(/\bhandle\b/);
    }
  });

  it("every subject/DID column is CHECKed to be a DID", () => {
    const source = sql();
    const didColumns = source.match(/subject_did text not null check \([^)]*\)/g) ?? [];
    expect(didColumns.length).toBeGreaterThanOrEqual(3);
    for (const column of didColumns) {
      expect(column).toContain("like 'did:%'");
    }
  });

  it("history stores the handle observed AT action time, in its own column", () => {
    // A schema that reused `handle` for this would let a rename rewrite
    // the audit trail.
    expect(sql()).toContain("subject_handle_at_action");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. Duplicate active Follow
// ─────────────────────────────────────────────────────────────────────

describe("NC2 — a duplicate active follow is refused", () => {
  it("a partial unique index covers pending/running actions", () => {
    const source = sql();
    // Break by dropping the WHERE clause, or the index, and this fails.
    expect(source).toMatch(
      /create unique index if not exists bluesky_relationship_actions_one_active[\s\S]*?\(workspace_id, operator_account_id, subject_did, action_type\)[\s\S]*?where status in \('pending', 'running'\)/,
    );
  });

  it("the index keys on subject_did, so two handles for one account still collide", () => {
    const source = sql();
    const index = /create unique index if not exists bluesky_relationship_actions_one_active[\s\S]*?;/.exec(
      source,
    )![0];
    expect(index).toContain("subject_did");
    expect(index).not.toContain("subject_handle");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Provider lookup failure becoming not_following
// ─────────────────────────────────────────────────────────────────────

describe("NC3 — a failed lookup is unknown, never not_following", () => {
  it("relationshipsUnavailable cannot emit not_following for any failure kind", () => {
    const kinds: GraphFailure["kind"][] = [
      "network",
      "rate_limited",
      "auth",
      "not_found",
      "provider_error",
    ];
    for (const kind of kinds) {
      const results = relationshipsUnavailable(
        ["did:plc:a", "did:plc:b"],
        failure({ kind }),
      );
      for (const r of results) {
        // Break by returning "not_following" here and every kind fails.
        expect(r.state).toBe("unknown");
      }
    }
  });

  it("an unanswered DID resolves to unknown, not to an absent edge", () => {
    for (const reason of ["absent", "not_found_actor"] as const) {
      const r = resolveRelationship({ did: "did:plc:a", known: false, reason });
      expect(r.state).toBe("unknown");
    }
  });

  it("only an ANSWERED object with neither key yields not_following", () => {
    const answered = resolveRelationship({
      did: "did:plc:a",
      known: true,
      followingUri: null,
      followedByUri: null,
    });
    expect(answered.state).toBe("not_following");
    // Which is the whole distinction: the same falsy `following` value,
    // two different meanings, separated by `known`.
  });

  it("an unknown state carries a reason, so the UI never shows a bare shrug", () => {
    const [r] = relationshipsUnavailable(["did:plc:a"], failure({ kind: "rate_limited" }));
    expect(r.unknownReason).toBeTruthy();
    expect(r.unknownReason).toContain("not confirmed as unfollowed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Unknown Follow outcome blindly retried
// ─────────────────────────────────────────────────────────────────────

describe("NC4 — an unknown follow outcome is never retried", () => {
  it("no follow classification produces a retry instruction", () => {
    const outcomes = [
      classifyFollowOutcome(failure({ kind: "network", status: 0 })),
      classifyFollowOutcome(failure({ status: 500 })),
      classifyFollowOutcome(failure({ status: 502 })),
      classifyFollowOutcome(failure({ status: 200 })),
    ];
    for (const outcome of outcomes) {
      // Break by adding a `{ kind: "retry" }` branch and this fails.
      expect(outcome.kind).toBe("ambiguous");
      expect(Object.keys(outcome)).not.toContain("retry");
    }
  });

  it("reconcileFollow can only conclude succeeded or reconciliation_required", () => {
    const states = [
      "following",
      "mutual",
      "unknown",
      "not_following",
      "follows_you",
    ] as const;
    for (const state of states) {
      const r = reconcileFollow({
        did: "did:plc:a",
        state,
        followRecord: null,
        unknownReason: state === "unknown" ? "provider down" : null,
      });
      expect(["succeeded", "reconciliation_required"]).toContain(r.status);
    }
  });

  it("a reconcile reading 'not following' does NOT authorise an automatic re-send", () => {
    const r = reconcileFollow({
      did: "did:plc:a",
      state: "not_following",
      followRecord: null,
      unknownReason: null,
    });
    expect(r.status).toBe("reconciliation_required");
    // operatorMayReissue is advisory for a PERSON. Nothing in the
    // executor reads it; the executor's own tests count exactly one
    // createRecord per ambiguous follow.
    expect(r.note).toContain("has not sent it again");
  });

  it("a reconcile that also fails does not authorise a re-send at all", () => {
    const r = reconcileFollow({
      did: "did:plc:a",
      state: "unknown",
      followRecord: null,
      unknownReason: "provider down",
    });
    expect(r.operatorMayReissue).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Unknown Unfollow outcome blindly retried
// ─────────────────────────────────────────────────────────────────────

describe("NC5 — an unknown unfollow outcome is never retried", () => {
  it("ambiguity is preserved even though deleteRecord is idempotent", () => {
    // Idempotence makes a repeat harmless; it does not make an
    // automatic repeat correct, because a loop that re-derives its
    // target is how the wrong record gets deleted.
    for (const f of [
      failure({ kind: "network", status: 0 }),
      failure({ status: 503 }),
    ]) {
      expect(classifyUnfollowOutcome(f).kind).toBe("ambiguous");
    }
  });

  it("reconcileUnfollow can only conclude succeeded or reconciliation_required", () => {
    for (const state of [
      "not_following",
      "follows_you",
      "following",
      "mutual",
      "unknown",
    ] as const) {
      const r = reconcileUnfollow({
        did: "did:plc:a",
        state,
        followRecord: null,
        unknownReason: null,
      });
      expect(["succeeded", "reconciliation_required"]).toContain(r.status);
    }
  });

  it("a still-following reconcile records the fact and says it did not re-send", () => {
    const r = reconcileUnfollow({
      did: "did:plc:a",
      state: "following",
      followRecord: { uri: "at://did:plc:me/app.bsky.graph.follow/3x", rkey: "3x" },
      unknownReason: null,
    });
    expect(r.status).toBe("reconciliation_required");
    expect(r.note).toContain("did not re-send");
  });
});

// ─────────────────────────────────────────────────────────────────────
// 6. Protected account included in batch unfollow
// ─────────────────────────────────────────────────────────────────────

describe("NC6 — protected accounts are excluded from unfollow", () => {
  it("protection refuses regardless of every other signal", () => {
    for (const state of ["following", "mutual", "unknown", "not_following"] as const) {
      for (const rkey of ["3x", null]) {
        const d = preflightUnfollow({
          subjectDid: "did:plc:a",
          currentState: state,
          protectedRelationship: true,
          followRkey: rkey,
        });
        // Break by moving the protection check below any other branch
        // and the not_following / missing-rkey combinations fail.
        expect(d.proceed).toBe(false);
        if (d.proceed) continue;
        expect(d.reason).toContain("Protected");
      }
    }
  });

  it("protection is checked FIRST, so its reason is the one reported", () => {
    // A protected candidate that is also missing an rkey would report
    // the rkey failure instead if the order were wrong, and the
    // operator would be told the wrong thing about why it was skipped.
    const d = preflightUnfollow({
      subjectDid: "did:plc:a",
      currentState: "following",
      protectedRelationship: true,
      followRkey: null,
    });
    expect(d.proceed).toBe(false);
    if (d.proceed) return;
    expect(d.status).toBe("skipped");
    expect(d.reason).toContain("Protected");
    expect(d.reason).not.toContain("record key");
  });

  it("the schema keeps protection on the candidate with an index for it", () => {
    expect(sql()).toContain("protected boolean not null default false");
    expect(sql()).toMatch(/bluesky_candidates_protected_idx[\s\S]*?where protected/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 7. Multiple source attribution lost
// ─────────────────────────────────────────────────────────────────────

describe("NC7 — source attribution accumulates and is never replaced", () => {
  it("sources are a join table, not an array column on the candidate", () => {
    const source = sql();
    // Break by putting `source_target_profile_ids uuid[]` on
    // bluesky_candidates instead, and this fails. An array gets
    // read-modify-written, and two concurrent imports lose one.
    expect(source).toContain("create table if not exists public.bluesky_candidate_sources");
    const candidateTable = /create table if not exists public\.bluesky_candidates \([\s\S]*?\n\);/.exec(
      source,
    )![0];
    expect(candidateTable).not.toMatch(/source_target_profile_ids/);
  });

  it("the join table is unique on (candidate, target), so a re-sighting is a no-op insert", () => {
    expect(sql()).toMatch(
      /create table if not exists public\.bluesky_candidate_sources[\s\S]*?unique \(candidate_id, target_profile_id\)/,
    );
  });

  it("history denormalises the attributions as an array frozen at action time", () => {
    // Deliberately an array HERE and not on the candidate: this one is
    // written once and never updated, so there is no lost-update race.
    expect(sql()).toContain(
      "source_target_profile_ids uuid[] not null default '{}'",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 8. Workspace scope removed
// ─────────────────────────────────────────────────────────────────────

describe("NC8 — workspace scope", () => {
  const repository = readFileSync(
    path.join(process.cwd(), "src/repositories/bluesky-relationship-repository.ts"),
    "utf8",
  );

  it("every relationship table is workspace-scoped and RLS-enabled", () => {
    const source = sql();
    for (const table of [
      "bluesky_target_profiles",
      "bluesky_import_runs",
      "bluesky_candidates",
      "bluesky_candidate_sources",
      "bluesky_action_batches",
      "bluesky_relationship_actions",
    ]) {
      expect(source).toContain(
        `alter table public.${table} enable row level security`,
      );
      const definition = new RegExp(
        `create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`,
      ).exec(source)![0];
      expect(definition).toContain("workspace_id uuid not null references public.workspaces(id)");
    }
  });

  it("the RLS policies gate on is_workspace_member", () => {
    expect(sql()).toContain("public.is_workspace_member(workspace_id)");
  });

  it("no action or batch table has a DELETE policy — history is not deletable", () => {
    const source = sql();
    const deletePolicies = source.match(/create policy "[^"]+" *\n? *on public\.(\w+) for delete/g) ?? [];
    for (const policy of deletePolicies) {
      expect(policy).not.toContain("bluesky_relationship_actions");
      expect(policy).not.toContain("bluesky_action_batches");
    }
  });

  it("EVERY read, update and delete filters on workspace_id in the query", () => {
    // RLS is a second line, not the first. Some callers legitimately
    // pass a service-role client, which bypasses policies entirely, so
    // the filter has to be in the query itself.
    //
    // This walks each exported repository function and checks the
    // operations it performs, rather than counting occurrences against
    // a threshold — a count can be satisfied by a filter in the wrong
    // function. Break by deleting any single `.eq("workspace_id", …)`
    // and this names the function it was removed from.
    //
    // It caught a real one while being written: recordCandidateSources
    // read the existing attribution rows filtered only by
    // (target_profile_id, candidate_id).
    const offenders: string[] = [];
    for (const match of repository.matchAll(/export (?:async )?function (\w+)/g)) {
      const name = match[1];
      const start = match.index ?? 0;
      const next = repository.indexOf("\nexport ", start + 1);
      const body = repository.slice(start, next > 0 ? next : repository.length);

      const operations = [
        ...body.matchAll(/\.from\("(bluesky_\w+)"\)\s*\n?\s*\.(\w+)\(/g),
      ];
      if (operations.length === 0) continue;

      const filtersWorkspace = body.includes('.eq("workspace_id"');
      const scopedOps = operations.filter(([, , verb]) =>
        ["select", "update", "delete"].includes(verb),
      );
      if (scopedOps.length > 0 && !filtersWorkspace) {
        offenders.push(`${name} (${scopedOps.map((o) => o[2]).join(", ")})`);
      }

      // Inserts and upserts carry workspace_id in the payload instead,
      // which is the equivalent guarantee for a write that creates a row.
      const writeOps = operations.filter(([, , verb]) =>
        ["insert", "upsert"].includes(verb),
      );
      if (writeOps.length > 0 && !body.includes("workspace_id:")) {
        offenders.push(`${name} (write without workspace_id in the payload)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("candidate and action reads are also scoped to the operator identity", () => {
    expect(repository).toContain('.eq("operator_account_id"');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 9. Import marked complete before cursor exhaustion
// ─────────────────────────────────────────────────────────────────────

describe("NC9 — completion requires cursor exhaustion", () => {
  it("the database CHECK refuses completed without cursor_exhausted", () => {
    // Break by deleting this constraint and the test fails; break it by
    // inverting the condition and it fails too.
    expect(sql()).toMatch(
      /constraint bluesky_import_runs_completion_requires_exhaustion\s*\n?\s*check \(status <> 'completed' or cursor_exhausted\)/,
    );
  });

  it("applyPage completes only on a null cursor, whatever the page length", () => {
    const state = {
      status: "running" as const,
      cursor: "c",
      cursorExhausted: false,
      pagesFetched: 1,
      followersSeen: 5,
    };
    const profile = {
      did: "did:plc:x",
      handle: null,
      displayName: null,
      avatarUrl: null,
      followersCount: null,
    };

    // The verified shape: limit=5 returning 3, with a cursor and more
    // data behind it. Break by adding `|| followers.length < limit` to
    // the completion condition and this fails.
    const short = applyPage({
      state,
      page: { followers: [profile, profile, profile], cursor: "next" },
      newFollowerCount: 3,
      pageBudget: 100,
    });
    expect(short.status).not.toBe("completed");
    expect(short.cursorExhausted).toBe(false);

    // An entirely empty page that still carries a cursor is likewise
    // not the end.
    const empty = applyPage({
      state,
      page: { followers: [], cursor: "next" },
      newFollowerCount: 0,
      pageBudget: 100,
    });
    expect(empty.status).not.toBe("completed");

    const done = applyPage({
      state,
      page: { followers: [profile], cursor: null },
      newFollowerCount: 1,
      pageBudget: 100,
    });
    expect(done.status).toBe("completed");
    expect(done.cursorExhausted).toBe(true);
  });

  it("no failure path can set cursorExhausted", () => {
    const state = {
      status: "running" as const,
      cursor: "c",
      cursorExhausted: false,
      pagesFetched: 1,
      followersSeen: 5,
    };
    for (const remaining of [0, 5, 1000]) {
      const paused = applyPage({
        state,
        page: { followers: [], cursor: "next" },
        newFollowerCount: 0,
        rateLimitRemaining: remaining,
        pageBudget: 100,
      });
      expect(paused.cursorExhausted).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 10. Newly imported candidate silently added to a confirmed batch
// ─────────────────────────────────────────────────────────────────────

describe("NC10 — a confirmed batch's membership is immutable", () => {
  it("a trigger refuses an insert carrying a confirmed batch id", () => {
    const source = sql();
    // Break by dropping the trigger and this fails. The behavioural
    // half of this control lives in execute-actions.test.ts, which
    // attempts the insert against the constraint-enforcing fake.
    expect(source).toContain(
      "create or replace function public.bluesky_batch_membership_is_frozen()",
    );
    expect(source).toMatch(
      /if v_confirmed_at is not null then[\s\S]*?raise exception[\s\S]*?membership is immutable/,
    );
    expect(source).toMatch(
      /create trigger bluesky_relationship_actions_batch_frozen\s*\n\s*before insert or update on public\.bluesky_relationship_actions/,
    );
  });

  it("the trigger also refuses moving an action between batches", () => {
    expect(sql()).toMatch(
      /if new\.batch_id is distinct from old\.batch_id then[\s\S]*?cannot be moved between batches/,
    );
  });

  it("updateAction never includes batch_id in its patch", () => {
    const repository = readFileSync(
      path.join(process.cwd(), "src/repositories/bluesky-relationship-repository.ts"),
      "utf8",
    );
    const updateFn = /export async function updateAction\([\s\S]*?\n}/.exec(repository)![0];
    expect(updateFn).not.toContain("batch_id");
  });

  it("the batch processor takes a fixed list and never queries for more work", () => {
    const executor = readFileSync(
      path.join(process.cwd(), "src/core/bluesky-relationships/execute-actions.server.ts"),
      "utf8",
    );
    const processFn = /export async function processBatchActions\([\s\S]*?\n}\n/.exec(
      executor,
    )![0];
    // Break by having it call a list function and this fails.
    expect(processFn).not.toMatch(/listBatchActions|listCandidates|\.from\(/);
    expect(processFn).toContain("input.actions");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bonus: the rkey is parsed, never derived
// ─────────────────────────────────────────────────────────────────────

describe("the follow record key is read from the provider, never computed", () => {
  it("rkeyFromAtUri only ever returns the URI's own last segment", () => {
    const cases = [
      ["at://did:plc:me/app.bsky.graph.follow/3kabcxyz", "3kabcxyz"],
      [
        "at://did:plc:me/app.bsky.graph.follow/did_plc_z72i7hdynmk6r22z27h6tvur",
        "did_plc_z72i7hdynmk6r22z27h6tvur",
      ],
    ] as const;
    for (const [uri, expected] of cases) {
      expect(rkeyFromAtUri(uri)).toBe(expected);
    }
  });

  it("no module builds an rkey out of a subject DID", () => {
    // Break by adding `rkey = subject.replace(/:/g, "_")` anywhere and
    // this fails.
    for (const file of [
      "src/core/bluesky-relationships/atproto-graph.ts",
      "src/core/bluesky-relationships/execute-actions.server.ts",
      "src/core/bluesky-relationships/mutation-outcome.ts",
      "src/repositories/bluesky-relationship-repository.ts",
    ]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      // A derivation would have to transform the DID's colons or
      // concatenate onto the collection name.
      expect(source).not.toMatch(/subjectDid\s*\.replace\(/);
      expect(source).not.toMatch(/subject_did\s*\.replace\(/);
      expect(source).not.toMatch(/rkey\s*[:=]\s*`\$\{[^}]*[Dd]id/);
    }
  });
});
