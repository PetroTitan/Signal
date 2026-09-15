import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUnfollowFixture,
  makeMembers,
  makeUnfollowCampaign,
  type UnfollowFixture,
} from "./test-support/harness";
import {
  activationFactsVersion,
  describeActivationDrift,
  loadUnfollowActivationFacts,
} from "./activation-facts.server";
import { computeNextRunAt, localClockAt } from "@/core/bluesky-campaigns/campaign-day";
import { confirmationHandleMatches, displayConfirmationHandle } from "./confirm-handle";

/**
 * PRODUCTION: the unfollow campaign was persisted with 00:00–01:00 UTC
 * and its confirmation dialog said 09:00–20:00 UTC — the wizard's form
 * defaults. The facts now come from the row; this proves they do, on
 * the shipped migrations, and that every fact a consent covers moves
 * the fingerprint activation compares against.
 */

let f: UnfollowFixture;
beforeAll(async () => {
  f = await createUnfollowFixture("facts");
  // Mirror production: the identity's stored handle carries its own `@`.
  await f.db.query(
    `update public.growth_accounts set handle = '@Operator.bsky.social' where id = $1`,
    [f.tenant.identityId],
  );
}, 180_000);
afterAll(async () => { await f?.close(); });

async function readyJob(campaignId: string, sourceKind = "following_records") {
  await f.db.query(
    `insert into public.bluesky_campaign_import_jobs
       (workspace_id, campaign_id, source_kind, status, source_exhausted, imported_count)
     values ($1,$2,$3,'ready',true,0)`,
    [f.tenant.workspaceId, campaignId, sourceKind],
  );
}

describe("the confirmation shows the PERSISTED schedule", () => {
  it("a 00:00–01:00 UTC campaign is described as 00:00–01:00 UTC — not the form's 09:00–20:00", async () => {
    const c = await makeUnfollowCampaign(f, "midnight window", {
      status: "ready",
      timezone: "UTC",
      windowStart: 0,
      windowEnd: 60,
      requestedDailyQuota: 300,
      dryRun: false,
    });
    await readyJob(c);
    await makeMembers(f, c, Array.from({ length: 5 }, (_, i) => ({ did: `did:plc:w${i}`, sequence: i + 1 })));

    const facts = (await loadUnfollowActivationFacts({
      workspaceId: f.tenant.workspaceId,
      campaignId: c,
      db: f.client,
    }))!;
    expect(facts).not.toBeNull();
    expect(facts.windowLabel).toBe("00:00–01:00");
    expect(facts.timezone).toBe("UTC");
    expect(facts.windowStartMinute).toBe(0);
    expect(facts.windowEndMinute).toBe(60);
    expect(facts.requestedDailyQuota).toBe(300);
    expect(facts.dryRun).toBe(false);
    expect(facts.sourceKind).toBe("following_records");
    expect(facts.discovered).toBe(5);
    expect(facts.remainingEligible).toBe(5);
    expect(facts.stillBuilding).toBe(false);

    // The row, the dialog and the activation all agree. The activation
    // computes next_run_at from the ROW — never from the dialog — and
    // it lands inside the persisted window.
    const row = (await f.db.query<{ tz: string; s: number; e: number }>(
      `select timezone as tz, execution_window_start_minute as s,
              execution_window_end_minute as e
         from public.bluesky_follow_campaigns where id = $1`, [c])).rows[0];
    expect([row.tz, row.s, row.e]).toEqual([facts.timezone, facts.windowStartMinute, facts.windowEndMinute]);
    const next = computeNextRunAt({
      from: new Date("2026-09-15T13:00:00Z"),
      timezone: row.tz,
      window: { startMinute: row.s, endMinute: row.e },
    });
    const clock = localClockAt(next, row.tz);
    expect(clock.minutesOfDay).toBeGreaterThanOrEqual(0);
    expect(clock.minutesOfDay).toBeLessThan(60);
    expect(clock.localDate).toBe("2026-09-16");
  });

  it("the handle the dialog asks for is accepted by the dialog and by the server, with one @", async () => {
    const c = await makeUnfollowCampaign(f, "handle", { status: "ready" });
    await readyJob(c);
    const facts = (await loadUnfollowActivationFacts({
      workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client,
    }))!;
    // Stored as `@Operator.bsky.social`; shown canonical; typed back as shown.
    expect(facts.actorHandle).toBe("operator.bsky.social");
    const shown = displayConfirmationHandle(facts.actorHandle);
    expect(shown).toBe("@operator.bsky.social");
    expect(confirmationHandleMatches(shown, facts.actorHandle)).toBe(true);
    // …and against the session's bare handle, which is what the server has.
    expect(confirmationHandleMatches(shown, "operator.bsky.social")).toBe(true);
    expect(confirmationHandleMatches("@@operator.bsky.social", facts.actorHandle)).toBe(false);
    expect(confirmationHandleMatches("@operator2.bsky.social", facts.actorHandle)).toBe(false);
  });
});

describe("the version covers every fact a consent is for", () => {
  it("is stable across reloads when nothing changed", async () => {
    const c = await makeUnfollowCampaign(f, "stable", { status: "ready" });
    await readyJob(c);
    const a = await loadUnfollowActivationFacts({ workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client });
    const b = await loadUnfollowActivationFacts({ workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client });
    expect(a!.version).toBe(b!.version);
    expect(a!.version).toHaveLength(32);
  });

  it.each([
    ["quota", `update public.bluesky_follow_campaigns set requested_daily_quota = 700 where id = $1`, "the daily number"],
    ["dry_run", `update public.bluesky_follow_campaigns set dry_run = not dry_run where id = $1`, "whether it is a dry run"],
    ["timezone", `update public.bluesky_follow_campaigns set timezone = 'America/New_York' where id = $1`, "the time zone"],
    ["window", `update public.bluesky_follow_campaigns set execution_window_start_minute = 540, execution_window_end_minute = 1200 where id = $1`, "the time of day"],
    ["queue count", `insert into public.bluesky_follow_campaign_members (workspace_id, campaign_id, subject_did, import_sequence, status)
                     select workspace_id, $1, 'did:plc:extra', 999, 'queued' from public.bluesky_follow_campaigns where id = $1`, "the number of profiles"],
    ["protection count", `update public.bluesky_follow_campaign_members set status = 'protected', protected_reason = 'allowlisted' where campaign_id = $1 and import_sequence = 1`, "the protected count"],
    ["allowlist count", `insert into public.bluesky_unfollow_allowlist (workspace_id, operator_account_id, subject_did, reason)
                         select workspace_id, operator_account_id, 'did:plc:keep', 'never' from public.bluesky_follow_campaigns where id = $1`, "the never-unfollow list"],
  ])("changing %s after review changes the version and is named in the drift", async (_label, sql, expectedDrift) => {
    const c = await makeUnfollowCampaign(f, `drift ${_label}`, { status: "ready" });
    await readyJob(c);
    await makeMembers(f, c, [{ did: `did:plc:d${_label.replace(/\s/g, "")}`, sequence: 1 }]);
    const reviewed = (await loadUnfollowActivationFacts({ workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client }))!;
    await f.db.query(sql, [c]);
    const current = (await loadUnfollowActivationFacts({ workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client }))!;
    expect(current.version).not.toBe(reviewed.version);
    expect(describeActivationDrift(reviewed, current)).toContain(expectedDrift);
  });

  it("the source is part of the consent: a different persisted source is a different version", () => {
    const base = {
      campaignId: "c", operatorAccountId: "i", sourceKind: "following_records",
      sourceTargetProfileId: null, discovered: 10, protectedExcluded: 0, allowlistCount: 0,
      requestedDailyQuota: 50, timezone: "UTC", windowStartMinute: 0, windowEndMinute: 60, dryRun: true,
    };
    expect(activationFactsVersion(base)).not.toBe(
      activationFactsVersion({ ...base, sourceKind: "target_followers", sourceTargetProfileId: "t1" }),
    );
    expect(activationFactsVersion(base)).not.toBe(activationFactsVersion({ ...base, operatorAccountId: "other" }));
    // …and a fact NOT in the consent (nothing here) cannot move it.
    expect(activationFactsVersion(base)).toBe(activationFactsVersion({ ...base }));
  });
});

describe("time zones and DST boundaries: row, dialog and activation agree", () => {
  it("fall back (America/New_York, 2026-11-01): a 01:00–03:00 window is shown as such and the next run lands inside it", async () => {
    const c = await makeUnfollowCampaign(f, "fall back", {
      status: "ready", timezone: "America/New_York", windowStart: 60, windowEnd: 180,
    });
    await readyJob(c);
    const facts = (await loadUnfollowActivationFacts({ workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client }))!;
    expect(facts.windowLabel).toBe("01:00–03:00");
    expect(facts.timezone).toBe("America/New_York");
    // 00:30 EDT on the fall-back day. 01:00 local happens twice that
    // night; whichever instant is chosen, its LOCAL clock is inside the
    // window on the local date the operator was shown.
    const next = computeNextRunAt({
      from: new Date("2026-11-01T04:30:00Z"),
      timezone: facts.timezone,
      window: { startMinute: facts.windowStartMinute, endMinute: facts.windowEndMinute },
    });
    const clock = localClockAt(next, facts.timezone);
    expect(clock.localDate).toBe("2026-11-01");
    expect(clock.minutesOfDay).toBeGreaterThanOrEqual(60);
    expect(clock.minutesOfDay).toBeLessThan(180);
  });

  it("spring forward (America/New_York, 2026-03-08): a 02:00–03:00 window does not exist that day and the next run is the first day it does", async () => {
    const c = await makeUnfollowCampaign(f, "spring forward", {
      status: "ready", timezone: "America/New_York", windowStart: 120, windowEnd: 180,
    });
    await readyJob(c);
    const facts = (await loadUnfollowActivationFacts({ workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client }))!;
    expect(facts.windowLabel).toBe("02:00–03:00");
    const next = computeNextRunAt({
      from: new Date("2026-03-08T06:00:00Z"), // 01:00 EST, an hour before the gap
      timezone: facts.timezone,
      window: { startMinute: facts.windowStartMinute, endMinute: facts.windowEndMinute },
    });
    const clock = localClockAt(next, facts.timezone);
    expect(next.getTime()).toBeGreaterThan(Date.parse("2026-03-08T06:00:00Z"));
    expect(clock.localDate).toBe("2026-03-09");
    expect(clock.minutesOfDay).toBeGreaterThanOrEqual(120);
    expect(clock.minutesOfDay).toBeLessThan(180);
  });

  it("a non-UTC zone: the label is local minutes, not a UTC conversion", async () => {
    const c = await makeUnfollowCampaign(f, "kolkata", {
      status: "ready", timezone: "Asia/Kolkata", windowStart: 9 * 60 + 30, windowEnd: 20 * 60,
    });
    await readyJob(c);
    const facts = (await loadUnfollowActivationFacts({ workspaceId: f.tenant.workspaceId, campaignId: c, db: f.client }))!;
    expect(facts.windowLabel).toBe("09:30–20:00");
    expect(facts.timezone).toBe("Asia/Kolkata");
  });
});

describe("workspace scope", () => {
  it("another workspace's campaign id yields nothing", async () => {
    const c = await makeUnfollowCampaign(f, "scoped", { status: "ready" });
    await readyJob(c);
    const other = await f.db.query<{ id: string }>(
      `insert into public.workspaces (name, slug, created_by) values ('other', 'other-facts', $1) returning id`,
      [f.tenant.ownerId],
    );
    expect(
      await loadUnfollowActivationFacts({ workspaceId: other.rows[0].id, campaignId: c, db: f.client }),
    ).toBeNull();
  });
});
