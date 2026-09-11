import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import {
  claimMembers,
  countMembersByStatus,
  getCampaign,
  listCampaigns,
  listMembersPage,
  listRunsPage,
  updateCampaign,
} from "@/repositories/bluesky-campaign-repository";

/**
 * Workspace isolation and command authorization.
 *
 * TWO DIFFERENT CLAIMS, KEPT APART
 * --------------------------------
 * 1. The RLS POLICIES exist and are shaped correctly. Asserted against
 *    the migration text, because there is no local Postgres in this
 *    repository — see the limitations section of the PR.
 * 2. Every query FILTERS by workspace regardless of RLS. This is the
 *    one that matters most here: the campaign worker runs as the
 *    SERVICE ROLE and bypasses policies entirely, so on the hot path
 *    the filter in the query is not a second line of defence — it is
 *    the only one.
 *
 * Neither is evidence for the other and the tests do not pretend
 * otherwise.
 */

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260911000002_bluesky_follow_campaigns.sql",
);
const sql = () => readFileSync(MIGRATION, "utf8");

const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const CAMPAIGN_TABLES = [
  "bluesky_follow_campaigns",
  "bluesky_follow_campaign_members",
  "bluesky_campaign_member_sources",
  "bluesky_follow_campaign_runs",
  "bluesky_identity_daily_usage",
  "bluesky_campaign_kill_switches",
];

describe("RLS policies exist for every new table", () => {
  it("row level security is enabled on all six", () => {
    for (const table of CAMPAIGN_TABLES) {
      expect(sql(), table).toContain(
        `alter table public.${table} enable row level security`,
      );
    }
  });

  it("every table carries a workspace_id with a real foreign key", () => {
    for (const table of CAMPAIGN_TABLES) {
      const definition = new RegExp(
        `create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`,
      ).exec(sql())![0];
      expect(definition, table).toContain(
        "workspace_id uuid not null references public.workspaces(id)",
      );
    }
  });

  it("policies gate on is_workspace_member, the existing helper", () => {
    // Reusing the established predicate rather than inventing a second
    // definition of "is a member" — two would eventually disagree.
    expect(sql()).toContain("public.is_workspace_member(workspace_id)");
    const loop = /foreach t in array array\[[\s\S]*?end loop;/.exec(sql())![0];
    for (const table of CAMPAIGN_TABLES) {
      expect(loop, table).toContain(`'${table}'`);
    }
    for (const verb of ["for select", "for insert", "for update"]) {
      expect(loop).toContain(verb);
    }
  });

  it("runs are NOT deletable — a run is the record of what was attempted", () => {
    const deletes = sql().match(/for delete/g) ?? [];
    expect(deletes.length).toBeGreaterThan(0);
    const deletePolicies =
      sql().match(/create policy "[^"]+"[\s\S]{0,120}?for delete/g) ?? [];
    for (const policy of deletePolicies) {
      expect(policy).not.toContain("bluesky_follow_campaign_runs");
      expect(policy).not.toContain("bluesky_identity_daily_usage");
    }
  });

  it("a campaign is only deletable while it is a draft", () => {
    // Deleting an activated campaign would orphan the follows it has
    // already made from the record explaining why they happened.
    expect(sql()).toMatch(
      /bluesky_follow_campaigns: members delete[\s\S]{0,240}status = 'draft'/,
    );
  });

  it("the claiming RPCs are revoked from anon and authenticated", () => {
    // They are SECURITY DEFINER and take the workspace as an argument,
    // so a client able to call them directly could claim across
    // workspaces. Only the service role reaches them.
    for (const fn of [
      "claim_bluesky_campaign_members",
      "release_bluesky_campaign_members",
      "ensure_bluesky_campaign_run",
      "record_bluesky_identity_usage",
    ]) {
      const revokes = sql().match(
        new RegExp(`revoke all on function public\\.${fn}[\\s\\S]{0,200}?;`, "g"),
      );
      expect(revokes, `${fn} must be revoked`).not.toBeNull();
      const joined = revokes!.join("\n");
      expect(joined, fn).toContain("from anon");
      expect(joined, fn).toContain("from authenticated");
      expect(joined, fn).toContain("from public");
    }
  });

  it("every SECURITY DEFINER function pins its search_path", () => {
    // A definer function without a fixed search_path is exploitable by
    // a caller who can create a shadowing object.
    const definers = sql().match(/security definer[\s\S]{0,120}?as \$\$/g) ?? [];
    expect(definers.length).toBeGreaterThanOrEqual(4);
    for (const fn of definers) {
      expect(fn).toContain("set search_path = public");
    }
  });
});

describe("cross-workspace reads are refused by the QUERY, not only by RLS", () => {
  function seedTwoWorkspaces(): FakeDb {
    const db = new FakeDb();
    db.tables.set("bluesky_follow_campaigns", [
      {
        id: "camp-a", workspace_id: "ws-a", operator_account_id: "acct-a",
        name: "Mine", status: "active", requested_daily_quota: 100,
        timezone: "UTC", execution_window_start_minute: 0,
        execution_window_end_minute: 1440,
      },
      {
        id: "camp-b", workspace_id: "ws-b", operator_account_id: "acct-b",
        name: "Theirs", status: "active", requested_daily_quota: 100,
        timezone: "UTC", execution_window_start_minute: 0,
        execution_window_end_minute: 1440,
      },
    ]);
    const members: Row[] = [];
    for (let i = 1; i <= 5; i += 1) {
      members.push({
        id: `a${i}`, workspace_id: "ws-a", campaign_id: "camp-a",
        subject_did: `did:plc:a${i}`, import_sequence: i, status: "queued",
        attempt_count: 0, next_attempt_at: null, lease_expires_at: null,
      });
      members.push({
        id: `b${i}`, workspace_id: "ws-b", campaign_id: "camp-b",
        subject_did: `did:plc:b${i}`, import_sequence: i, status: "queued",
        attempt_count: 0, next_attempt_at: null, lease_expires_at: null,
      });
    }
    db.tables.set("bluesky_follow_campaign_members", members);
    db.tables.set("bluesky_follow_campaign_runs", [
      { id: "run-a", workspace_id: "ws-a", campaign_id: "camp-a",
        local_date: "2026-09-11", status: "running", requested_daily_quota: 100,
        effective_daily_quota: 100, attempted_count: 0, succeeded_count: 0,
        already_following_count: 0, skipped_count: 0, failed_count: 0,
        consecutive_failures: 0 },
      { id: "run-b", workspace_id: "ws-b", campaign_id: "camp-b",
        local_date: "2026-09-11", status: "running", requested_daily_quota: 100,
        effective_daily_quota: 100, attempted_count: 0, succeeded_count: 0,
        already_following_count: 0, skipped_count: 0, failed_count: 0,
        consecutive_failures: 0 },
    ]);
    return db;
  }

  it("listCampaigns returns only the caller's workspace", async () => {
    const db = seedTwoWorkspaces();
    const mine = await listCampaigns("ws-a", 50, db.client());
    expect(mine.map((c) => c.id)).toEqual(["camp-a"]);
  });

  it("getCampaign refuses another workspace's campaign by id", async () => {
    const db = seedTwoWorkspaces();
    // Knowing the uuid is not authorization.
    expect(await getCampaign("ws-a", "camp-b", db.client())).toBeNull();
    expect(await getCampaign("ws-b", "camp-b", db.client())).not.toBeNull();
  });

  it("listMembersPage never returns another workspace's queue", async () => {
    const db = seedTwoWorkspaces();
    const page = await listMembersPage({
      workspaceId: "ws-a", campaignId: "camp-a", db: db.client(),
    });
    expect(page.info.total).toBe(5);
    expect(page.rows.every((m) => String(m.subject_did).startsWith("did:plc:a"))).toBe(true);

    // And asking for the other workspace's campaign with our own
    // workspace id returns nothing rather than their rows.
    const crossed = await listMembersPage({
      workspaceId: "ws-a", campaignId: "camp-b", db: db.client(),
    });
    expect(crossed.info.total).toBe(0);
    expect(crossed.rows).toEqual([]);
  });

  it("counts are workspace-scoped too — a leak in a count is still a leak", async () => {
    const db = seedTwoWorkspaces();
    const counts = await countMembersByStatus({
      workspaceId: "ws-a", campaignId: "camp-a", db: db.client(),
    });
    expect(counts.total).toBe(5);
    const crossed = await countMembersByStatus({
      workspaceId: "ws-a", campaignId: "camp-b", db: db.client(),
    });
    expect(crossed.total).toBe(0);
  });

  it("listRunsPage is workspace-scoped", async () => {
    const db = seedTwoWorkspaces();
    const runs = await listRunsPage({
      workspaceId: "ws-a", campaignId: "camp-a", db: db.client(),
    });
    expect(runs.rows.map((r) => r.id)).toEqual(["run-a"]);
  });

  it("claiming never crosses a workspace boundary", async () => {
    const db = seedTwoWorkspaces();
    // The worker passes the workspace explicitly BECAUSE it bypasses
    // RLS. Wrong workspace, right campaign id: nothing.
    const wrong = await claimMembers({
      workspaceId: "ws-a", campaignId: "camp-b", chunkSize: 50,
      leaseSeconds: 300, claimedBy: "w", db: db.client(),
    });
    expect(wrong).toEqual([]);
    // And ws-b's rows are untouched.
    expect(
      db.rows("bluesky_follow_campaign_members").filter((m) => m.status !== "queued"),
    ).toEqual([]);
  });

  it("cross-workspace MUTATION is refused", async () => {
    const db = seedTwoWorkspaces();
    const updated = await updateCampaign({
      workspaceId: "ws-a", campaignId: "camp-b", status: "cancelled",
      db: db.client(),
    });
    expect(updated).toBeNull();
    expect(
      db.rows("bluesky_follow_campaigns").find((c) => c.id === "camp-b")!.status,
    ).toBe("active");
  });
});

describe("every repository function is workspace-scoped", () => {
  const repository = readFileSync(
    path.join(process.cwd(), "src/repositories/bluesky-campaign-repository.ts"),
    "utf8",
  );

  /**
   * The one function that is deliberately NOT workspace-scoped.
   *
   * The cron dispatcher serves every workspace, so its "what is due"
   * query has to span them. It is safe because it returns whole
   * campaign rows and every subsequent operation uses
   * `campaign.workspace_id` — the scope travels with the row rather
   * than being assumed. Named here rather than silently excluded, in
   * the same spirit as the MCP guard's GLOBAL_TABLES allowlist: an
   * exception that is written down is auditable, one that is implicit
   * is a hole.
   */
  const WORKSPACE_SPANNING = new Set(["listDueCampaigns"]);

  it("listDueCampaigns is the only workspace-spanning read, and it is intentional", () => {
    const start = repository.indexOf("export async function listDueCampaigns");
    const next = repository.indexOf("\nexport ", start + 1);
    const body = repository.slice(start, next);
    // It must filter to ACTIVE campaigns — a dispatcher that swept
    // paused or cancelled ones would resume work an operator stopped.
    expect(body).toContain('.eq("status", "active")');
    // And it must return the workspace id, so the scope travels.
    expect(body).toContain('.select("*")');
  });

  it("no read, update or delete omits the workspace filter", () => {
    const offenders: string[] = [];
    for (const match of repository.matchAll(/export (?:async )?function (\w+)/g)) {
      const name = match[1];
      const start = match.index ?? 0;
      const next = repository.indexOf("\nexport ", start + 1);
      const body = repository.slice(start, next > 0 ? next : repository.length);

      if (WORKSPACE_SPANNING.has(name)) continue;

      const ops = [...body.matchAll(/\.from\("(bluesky_\w+)"\)\s*\n?\s*\.(\w+)\(/g)];
      if (ops.length === 0) continue;

      const scoped =
        body.includes('.eq("workspace_id"') ||
        body.includes("applyFilters(") ||
        body.includes("scope(");
      const reads = ops.filter(([, , verb]) =>
        ["select", "update", "delete"].includes(verb),
      );
      if (reads.length > 0 && !scoped) offenders.push(`${name} (read/write)`);

      const writes = ops.filter(([, , verb]) => ["insert", "upsert"].includes(verb));
      if (writes.length > 0 && !body.includes("workspace_id:")) {
        offenders.push(`${name} (write without workspace_id)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every RPC wrapper passes the workspace explicitly", () => {
    // The RPCs are SECURITY DEFINER and see no RLS context, so the
    // workspace has to travel as an argument.
    for (const call of repository.match(/\.rpc\(\s*"[^"]+",[\s\S]{0,400}?\)/g) ?? []) {
      expect(call).toContain("p_workspace_id");
    }
  });
});

describe("command authorization", () => {
  const actions = code(
    readFileSync(
      path.join(process.cwd(), "src/app/(app)/relationships/campaigns/_actions.ts"),
      "utf8",
    ),
  );

  const exported = [...actions.matchAll(/export async function (\w+Action)\(/g)].map(
    (m) => m[1],
  );

  it("exports exactly the commands the UI needs", () => {
    expect(exported.sort()).toEqual([
      "activateCampaignAction",
      "cancelCampaignAction",
      "changeQuotaAction",
      "createCampaignAction",
      "importCampaignMembersAction",
      "pauseCampaignAction",
      "setKillSwitchAction",
    ]);
  });

  it("EVERY command establishes the context before doing anything", () => {
    for (const name of exported) {
      const start = actions.indexOf(`export async function ${name}(`);
      const next = actions.indexOf("\nexport ", start + 1);
      const body = actions.slice(start, next > 0 ? next : actions.length);
      expect(body, `${name} does not establish a context`).toContain(
        "requireCampaignContext",
      );
    }
  });

  it("the context helper checks user, workspace and permission", () => {
    const helper = /async function requireCampaignContext\([\s\S]*?\n}/.exec(
      actions,
    )![0];
    expect(helper).toContain("supabase.auth.getUser()");
    expect(helper).toContain("getPrimaryWorkspace()");
    expect(helper).toContain('can(membership.role, "connect_platforms")');
  });

  it("every command naming a campaign re-resolves it in the workspace", () => {
    for (const name of [
      "activateCampaignAction",
      "pauseCampaignAction",
      "cancelCampaignAction",
      "changeQuotaAction",
      "importCampaignMembersAction",
    ]) {
      const start = actions.indexOf(`export async function ${name}(`);
      const next = actions.indexOf("\nexport ", start + 1);
      const body = actions.slice(start, next > 0 ? next : actions.length);
      expect(body, name).toContain("requireCampaign(ctx, campaignId)");
    }
  });

  it("never reads a workspace id from the client", () => {
    // The workspace comes from the session. A form field would let a
    // caller name someone else's workspace.
    expect(actions).not.toMatch(/formData\.get\(\s*["']workspace_id["']/);
    expect(actions).not.toMatch(/formData\.get\(\s*["']workspaceId["']/);
  });

  it("never reads a quota, a count or a member list from the client", () => {
    // The effective quota is computed per run by the server; members
    // are chosen by the claiming RPC.
    expect(actions).not.toMatch(/formData\.get\(\s*["']effective/);
    expect(actions).not.toMatch(/formData\.get\(\s*["'].*count["']/);
    expect(actions).not.toMatch(/formData\.getAll\(\s*["']member_id["']/);
  });

  it("validates the requested quota against the closed option set", () => {
    // A bounded number would still let a caller pick 999; the options
    // are a deliberate product decision.
    expect(actions).toContain("isDailyQuota(quotaRaw)");
    expect(actions).toContain("isDailyQuota(quota)");
  });

  it("lifecycle transitions use compare-and-set guards", () => {
    for (const name of ["activateCampaignAction", "pauseCampaignAction", "cancelCampaignAction"]) {
      const start = actions.indexOf(`export async function ${name}(`);
      const next = actions.indexOf("\nexport ", start + 1);
      const body = actions.slice(start, next > 0 ? next : actions.length);
      expect(body, name).toContain("expectedStatuses");
    }
  });

  it("no command can dispatch an unfollow", () => {
    // Checked as CODE, not as prose: the cancel action's copy says "this
    // does not unfollow anyone", which is exactly the sentence an
    // operator needs and which a naive word search would forbid.
    for (const forbidden of [
      "deleteRecord",
      "deleteFollowRecord",
      "executeUnfollowAction",
      "unfollowSelectedAction",
    ]) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
    // And no import pulls an unfollow capability into scope.
    const imports = actions.match(/^import[\s\S]*?from "[^"]+";$/gm) ?? [];
    for (const line of imports) {
      expect(line.toLowerCase()).not.toContain("unfollow");
    }
  });
});

describe("the cron endpoint is protected and bounded", () => {
  const route = code(
    readFileSync(
      path.join(process.cwd(), "src/app/api/campaigns/bluesky/tick/route.ts"),
      "utf8",
    ),
  );

  it("uses the shared constant-time cron auth", () => {
    expect(route).toContain("authorizeCronRequest(request)");
    expect(route).toMatch(/if \(!auth\.ok\)[\s\S]{0,200}status: auth\.status/);
  });

  it("checks the deploy-level kill switch before dispatching", () => {
    // Compared inside the handler, not across the whole file — the
    // import of dispatchCampaigns naturally appears first.
    const handler = route.slice(route.indexOf("export async function GET"));
    const killAt = handler.indexOf("isGloballyDisabledByEnv()");
    const dispatchAt = handler.indexOf("dispatchCampaigns({");
    expect(killAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(killAt).toBeLessThan(dispatchAt);
  });

  it("accepts no client input at all", () => {
    // No body, no query parameters: nothing a caller sends can change
    // which workspace, campaign or quota is processed.
    expect(route).not.toContain("request.json()");
    expect(route).not.toContain("searchParams");
  });

  it("declares an explicit duration budget", () => {
    expect(route).toMatch(/export const maxDuration = \d+;/);
    expect(route).toContain('export const runtime = "nodejs"');
  });

  it("does not 500 on failure — that would invite platform retries", () => {
    expect(route).toMatch(/ok: false,[\s\S]{0,120}error:/);
    const catchBlock = /catch \(err\) \{[\s\S]*?\n  \}/.exec(route)![0];
    expect(catchBlock).not.toContain("status: 500");
  });
});
