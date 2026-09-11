import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { can, ROLE_PERMISSIONS } from "@/core/teams/permissions";
import { AUTHENTICATED_ROUTES } from "@/core/navigation/route-manifest";

/**
 * Authorization for the relationship surface.
 *
 * These are structural assertions over the server-action module rather
 * than invocations of it: the actions call `createSupabaseServerClient`
 * and `getPrimaryWorkspace`, which need a Next request scope that does
 * not exist under vitest. Running them here would require mocking away
 * the very thing under test, which proves nothing.
 *
 * So what is asserted is the shape the gate must have — that every
 * exported action runs the context helper, that the helper performs all
 * four checks, and that the permission model is used as a matrix rather
 * than a ladder. Each of these fails if the corresponding code is
 * removed.
 */

const ACTIONS_PATH = path.join(
  process.cwd(),
  "src/app/(app)/relationships/_actions.ts",
);
const source = readFileSync(ACTIONS_PATH, "utf8");

/**
 * Strip comments before matching.
 *
 * The first version of the "no scheduler" control below matched the
 * raw file and failed on this module's own doc comment, which says
 * there is "none that schedules relationship work". A control that
 * fires on prose describing the invariant is worse than no control: it
 * pressures the next person to delete the explanation.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** The exported server actions, excluding type-only exports. */
function exportedActions(): string[] {
  return [...source.matchAll(/export async function (\w+Action)\(/g)].map(
    (m) => m[1],
  );
}

function bodyOf(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next > 0 ? next : source.length);
}

describe("every server action is gated", () => {
  it("exports the actions the UI needs and nothing unexpected", () => {
    expect(exportedActions().sort()).toEqual([
      "addTargetAction",
      "followSelectedAction",
      "importFollowersAction",
      "refreshRelationshipsAction",
      "removeTargetAction",
      "setProtectedAction",
      "unfollowSelectedAction",
    ]);
  });

  it("every action establishes a context before doing anything", () => {
    for (const name of exportedActions()) {
      const body = bodyOf(name);
      // followSelected / unfollowSelected delegate to
      // runRelationshipBatch, which does the gating.
      const gated =
        body.includes("requireRelationshipContext") ||
        body.includes("runRelationshipBatch");
      expect(gated, `${name} does not establish a context`).toBe(true);
    }
  });

  it("the context helper checks user, workspace, permission and identity ownership", () => {
    const helper = /async function requireRelationshipContext\([\s\S]*?\n}/.exec(
      source,
    )![0];
    // 1. authenticated user
    expect(helper).toContain("supabase.auth.getUser()");
    // 2. workspace membership
    expect(helper).toContain("getPrimaryWorkspace()");
    // 3. permission
    expect(helper).toContain("can(membership.role, permission)");
    // 4. the identity belongs to THAT workspace — an account id is a
    //    bare uuid in a form field until this query survives.
    expect(helper).toContain(
      "getAccountById(membership.workspace.id, operatorAccountId)",
    );
    expect(helper).toContain('identity.platform !== "bluesky"');
  });

  it("every mutation requires connect_platforms", () => {
    const mutations = [
      "addTargetAction",
      "importFollowersAction",
      "removeTargetAction",
      "setProtectedAction",
      "refreshRelationshipsAction",
    ];
    for (const name of mutations) {
      expect(bodyOf(name)).toContain('"connect_platforms"');
    }
    const batch = /async function runRelationshipBatch\([\s\S]*?\n}\n/.exec(source)![0];
    expect(batch).toContain('"connect_platforms"');
  });
});

describe("the role model is a matrix, not a ladder", () => {
  it("no action compares roles by ordering", () => {
    // Break by writing `role >= "editor"` and this fails. The roles do
    // not form a total order for this purpose.
    expect(source).not.toMatch(/role\s*[><]=?\s*["']/);
    expect(source).not.toMatch(/ROLE_ORDER|roleRank|roleLevel/);
  });

  it("connect_platforms is genuinely not implied by content permissions", () => {
    // The concrete reason a ladder would be wrong here: reviewer can
    // approve content — a "higher" act by most intuitions — and still
    // must not act as the account in public.
    expect(can("reviewer", "approve_content")).toBe(true);
    expect(can("reviewer", "connect_platforms")).toBe(false);
    expect(can("editor", "edit_content")).toBe(true);
    expect(can("editor", "connect_platforms")).toBe(false);
    expect(can("admin", "connect_platforms")).toBe(true);
    expect(can("owner", "connect_platforms")).toBe(true);
    expect(can("viewer", "connect_platforms")).toBe(false);
  });

  it("no new permission was invented for this milestone", () => {
    // The relationship surface reuses the existing matrix rather than
    // widening it, so there is one place to reason about access.
    const permissions = ROLE_PERMISSIONS.owner;
    expect(permissions.has("connect_platforms")).toBe(true);
    expect(source).not.toMatch(/"manage_relationships"|"follow_accounts"/);
  });
});

describe("the route is registered and permission-scoped", () => {
  const entry = AUTHENTICATED_ROUTES.find((r) => r.href === "/relationships");

  it("appears in the route manifest exactly once", () => {
    expect(
      AUTHENTICATED_ROUTES.filter((r) => r.href === "/relationships"),
    ).toHaveLength(1);
  });

  it("is reachable from a navigation surface, not orphaned", () => {
    expect(entry?.tier).toBe("secondary");
  });

  it("carries the same permission the actions enforce", () => {
    // The manifest hides the entry; the server actions are the
    // boundary. They agree so the UI does not offer what the server
    // will refuse.
    expect(entry?.permission).toBe("connect_platforms");
  });
});

describe("no action can run without an operator", () => {
  it("there is no scheduled, cron or background entry point", () => {
    // Comments are stripped first: this module's own doc comment says
    // there is "none that schedules relationship work", and a control
    // that fires on the sentence describing the invariant would push
    // the next person to delete the explanation.
    for (const file of [
      "src/app/(app)/relationships/_actions.ts",
      "src/core/bluesky-relationships/execute-actions.server.ts",
      "src/core/bluesky-relationships/import-followers.server.ts",
    ]) {
      const body = code(readFileSync(path.join(process.cwd(), file), "utf8"));
      // A recurring timer is a scheduler however it is dressed up.
      expect(body, file).not.toMatch(/setInterval/i);
      expect(body, file).not.toMatch(/cron/i);
      expect(body, file).not.toMatch(/dailyQuota|dailyLimit|perDay/i);

      // `setTimeout` is permitted in exactly one place: the default
      // `sleep` that spaces successive requests inside a batch the
      // operator already started. It delays work in flight; it does not
      // start work. Anything beyond that one occurrence is a scheduler.
      const timers = body.match(/setTimeout/g) ?? [];
      expect(timers.length, `${file} has ${timers.length} setTimeout uses`).toBeLessThanOrEqual(1);
      if (timers.length === 1) {
        expect(body).toMatch(
          /sleep\s*\?\?\s*\(\(ms: number\) => new Promise\(\(r\) => setTimeout\(r, ms\)\)\)/,
        );
      }
    }
  });

  it("no relationship route or cron manifest entry exists", () => {
    // The executor could be reached by an HTTP route as well as by a
    // timer. There is none, and vercel.json schedules none.
    const vercel = readFileSync(path.join(process.cwd(), "vercel.json"), "utf8");
    expect(vercel).not.toMatch(/relationship/i);
  });

  it("every action's initiator is recorded as an operator, never a system", () => {
    expect(source).toContain('"operator_single"');
    expect(source).toContain('"operator_batch"');
    const migration = readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260911000001_bluesky_relationship_actions.sql",
      ),
      "utf8",
    );
    // The column's CHECK admits no third value, so there is no way to
    // record a mutation that nobody asked for.
    expect(migration).toContain(
      "check (initiator_kind in ('operator_single', 'operator_batch'))",
    );
  });

  it("the unfollow decision structurally cannot see follow-back status", () => {
    // The strongest form of this boundary is not "no code does it" but
    // "the deciding function is not given the input". preflightUnfollow
    // receives the subject DID, the relationship state, the protected
    // flag and the record key — and `currentState` is consulted only
    // for `not_following`, never for `follows_you`.
    //
    // A first attempt at this control grepped execute-actions for
    // `follows_you` near `unfollow` and failed on the line that WRITES
    // follows_you after a successful unfollow (removing our edge does
    // not remove theirs). Matching on proximity in prose-shaped code
    // cannot tell a decision from a recording; reading the decision
    // function's signature can.
    const outcomes = readFileSync(
      path.join(
        process.cwd(),
        "src/core/bluesky-relationships/mutation-outcome.ts",
      ),
      "utf8",
    );
    const input = /export interface UnfollowPreflightInput \{[\s\S]*?\n\}/.exec(
      outcomes,
    )![0];
    expect(input).not.toMatch(/followsBack|followedBy|reciprocal/i);

    const fn = /export function preflightUnfollow\([\s\S]*?\n\}/.exec(outcomes)![0];
    expect(code(fn)).not.toContain("follows_you");
  });

  it("no module implements follow-back farming or a churn cycle", () => {
    for (const file of [
      "src/app/(app)/relationships/_actions.ts",
      "src/core/bluesky-relationships/execute-actions.server.ts",
      "src/core/bluesky-relationships/mutation-outcome.ts",
    ]) {
      const body = code(readFileSync(path.join(process.cwd(), file), "utf8"));
      expect(body, file).not.toMatch(/followBack|follow_back|reciprocat/i);
      expect(body, file).not.toMatch(/randomDelay|jitter|humanize|humanise/i);
    }
  });
});
