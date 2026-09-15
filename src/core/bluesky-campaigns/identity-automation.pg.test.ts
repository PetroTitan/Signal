import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFollowFixture,
  makeFollowCampaign,
  makeMembers,
  makeUnfollowCampaign,
  makeUnfollowMembers,
  type FollowFixture,
} from "./test-support/pg-harness";
import { loadIdentityAutomation, loadCampaignSummary } from "./load-campaign-summary.server";
import { loadCampaigns } from "./load-campaigns.server";

/**
 * The Relationships status panel and the Campaigns list, on the shipped
 * migrations.
 *
 * PRODUCTION: two follow campaigns were active on one identity and the
 * panel showed one. An unfollow campaign was listed under "Follow
 * campaigns" and opened the follow detail with a setup form beneath it.
 */

let f: FollowFixture;
let identityB: string;
let otherWorkspace: string;
const NOW = "2026-09-16T12:00:00Z";

beforeAll(async () => {
  f = await createFollowFixture("automation");
  // A second Bluesky identity in the same workspace.
  identityB = (await f.db.query<{ id: string }>(
    `insert into public.growth_accounts (workspace_id, platform, handle, display_name, status, connection_status)
     values ($1, 'bluesky', '@second.bsky.social', 'Second', 'active', 'connected') returning id`,
    [f.tenant.workspaceId])).rows[0].id;
  // A second workspace with its own identity and campaign.
  otherWorkspace = (await f.db.query<{ id: string }>(
    `insert into public.workspaces (name, slug, created_by) values ('other', 'other-automation', $1) returning id`,
    [f.tenant.ownerId])).rows[0].id;
  const otherIdentity = (await f.db.query<{ id: string }>(
    `insert into public.growth_accounts (workspace_id, platform, handle, display_name, status, connection_status)
     values ($1, 'bluesky', '@elsewhere.bsky.social', 'Elsewhere', 'active', 'connected') returning id`,
    [otherWorkspace])).rows[0].id;
  await f.db.query(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, kind, status, requested_daily_quota, timezone,
        execution_window_start_minute, execution_window_end_minute, created_by)
     values ($1, $2, 'Other workspace', 'follow', 'active', 100, 'UTC', 0, 1440, $3)`,
    [otherWorkspace, otherIdentity, f.tenant.ownerId]);
}, 180_000);
afterAll(async () => { await f?.close(); });

describe("every live campaign of the selected identity", () => {
  it("shows two follow campaigns AND an unfollow campaign on one identity, each with its kind — never just one", async () => {
    const F1 = await makeFollowCampaign(f, "Follow one", { requestedDailyQuota: 300 });
    const F2 = await makeFollowCampaign(f, "Follow two", { requestedDailyQuota: 200 });
    const U1 = await makeUnfollowCampaign(f, "Unfollow one", { requestedDailyQuota: 100 });
    const paused = await makeFollowCampaign(f, "Paused", { status: "paused" });
    const done = await makeFollowCampaign(f, "Done", { status: "completed" });
    await makeMembers(f, F1, 30, "ia");
    await makeMembers(f, F2, 20, "ib");
    await makeUnfollowMembers(f, U1, 10, "iu");
    await makeMembers(f, paused, 5, "ip");
    await makeMembers(f, done, 5, "id");
    // Identity B has its own live campaign; it must not appear under A.
    const B1 = (await f.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name, kind, status, requested_daily_quota, timezone,
          execution_window_start_minute, execution_window_end_minute, created_by)
       values ($1, $2, 'B campaign', 'follow', 'rate_limited', 100, 'UTC', 0, 1440, $3) returning id`,
      [f.tenant.workspaceId, identityB, f.tenant.ownerId])).rows[0].id;
    // Today's shared spend on identity A.
    await f.db.query(
      `insert into public.bluesky_identity_daily_usage
         (workspace_id, operator_account_id, usage_date, follows_created, attempts_made, unfollows_deleted)
       values ($1, $2, '2026-09-16', 40, 45, 5)`, [f.tenant.workspaceId, f.tenant.identityId]);

    const a = (await loadIdentityAutomation({
      workspaceId: f.tenant.workspaceId,
      operatorAccountId: f.tenant.identityId,
      now: new Date(NOW),
      db: f.client,
    }))!;
    expect(a).not.toBeNull();
    expect(a.campaigns.map((c) => [c.id, c.kind])).toEqual(
      expect.arrayContaining([[F1, "follow"], [F2, "follow"], [U1, "unfollow"]]),
    );
    expect(a.campaigns).toHaveLength(3);
    expect(a.campaigns.map((c) => c.id)).not.toContain(paused);
    expect(a.campaigns.map((c) => c.id)).not.toContain(done);
    expect(a.campaigns.map((c) => c.id)).not.toContain(B1);
    // Each card carries what the operator needs.
    const f1 = a.campaigns.find((c) => c.id === F1)!;
    expect(f1.total).toBe(30);
    expect(f1.requestedDailyQuota).toBe(300);
    expect(f1.effectiveDailyQuota).toBeGreaterThan(0);
    expect(f1.href).toBe(`/relationships/campaigns?campaign=${F1}`);
    const u1 = a.campaigns.find((c) => c.id === U1)!;
    expect(u1.href).toBe(`/relationships/unfollow/${U1}`);
    expect(u1.total).toBe(10);
    // The shared ceiling, with both kinds' spend.
    expect(a.ceiling).toBe(1000);
    expect(a.followsToday).toBe(40);
    expect(a.unfollowsToday).toBe(5);
    expect(a.attemptsToday).toBe(45);
    expect(a.otherIdentitiesLive).toBe(1);

    // Identity B sees its own, and only its own.
    const b = (await loadIdentityAutomation({
      workspaceId: f.tenant.workspaceId, operatorAccountId: identityB, now: new Date(NOW), db: f.client,
    }))!;
    expect(b.campaigns.map((c) => c.id)).toEqual([B1]);
    expect(b.campaigns[0].status).toBe("rate_limited");

    // The deprecated single summary is the first card, never a silent choice.
    const single = await loadCampaignSummary({ workspaceId: f.tenant.workspaceId, now: new Date(NOW), db: f.client });
    expect(single).not.toBeNull();
    expect(a.campaigns.map((c) => c.id)).toContain(single!.id);
  });

  it("a selected identity with nothing live says so rather than borrowing another identity's campaigns", async () => {
    const idle = (await f.db.query<{ id: string }>(
      `insert into public.growth_accounts (workspace_id, platform, handle, display_name, status, connection_status)
       values ($1, 'bluesky', '@idle.bsky.social', 'Idle', 'active', 'connected') returning id`,
      [f.tenant.workspaceId])).rows[0].id;
    const a = (await loadIdentityAutomation({
      workspaceId: f.tenant.workspaceId, operatorAccountId: idle, now: new Date(NOW), db: f.client,
    }))!;
    expect(a.identityId).toBe(idle);
    expect(a.campaigns).toEqual([]);
    expect(a.otherIdentitiesLive).toBeGreaterThan(0);
  });

  it("is workspace-scoped: the other workspace sees only its own campaign", async () => {
    const o = (await loadIdentityAutomation({ workspaceId: otherWorkspace, now: new Date(NOW), db: f.client }))!;
    expect(o.campaigns.map((c) => c.name)).toEqual(["Other workspace"]);
    expect(o.otherIdentitiesLive).toBe(0);
  });
});

describe("the Campaigns list", () => {
  it("lists both kinds with the kind on each; an unfollow id redirects to its own screen; the default detail is a FOLLOW campaign", async () => {
    const view = await loadCampaigns({ workspaceId: f.tenant.workspaceId, now: new Date(NOW), db: f.client });
    expect(view.failure).toBeNull();
    expect(view.kindFilter).toBe("all");
    expect(view.campaigns.some((c) => c.kind === "unfollow")).toBe(true);
    expect(view.campaigns.some((c) => c.kind === "follow")).toBe(true);
    expect(view.selected?.campaign.kind).toBe("follow");
    expect(view.redirectTo).toBeNull();

    const unfollowId = view.campaigns.find((c) => c.kind === "unfollow")!.id;
    const redirected = await loadCampaigns({
      workspaceId: f.tenant.workspaceId, campaignId: unfollowId, now: new Date(NOW), db: f.client,
    });
    expect(redirected.selected).toBeNull();
    expect(redirected.redirectTo).toBe(`/relationships/unfollow/${unfollowId}`);

    const onlyUnfollow = await loadCampaigns({
      workspaceId: f.tenant.workspaceId, kind: "unfollow", now: new Date(NOW), db: f.client,
    });
    expect(onlyUnfollow.campaigns.every((c) => c.kind === "unfollow")).toBe(true);
    expect(onlyUnfollow.selected).toBeNull();

    const onlyFollow = await loadCampaigns({
      workspaceId: f.tenant.workspaceId, kind: "follow", now: new Date(NOW), db: f.client,
    });
    expect(onlyFollow.campaigns.every((c) => c.kind === "follow")).toBe(true);
    expect(onlyFollow.selected?.campaign.kind).toBe("follow");
  });
});
