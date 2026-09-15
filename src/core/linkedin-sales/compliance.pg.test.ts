/**
 * The compliance tools against real PostgreSQL: suppression that reaches
 * every campaign, deletion requests that leave only the key, the
 * retention purge, exports, and who may run them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "@/test/pg/harness";
import { pgliteSupabase } from "@/test/pg/supabase-adapter";
import {
  activateCampaign,
  campaignConservation,
  createCampaign,
  createLeadList,
  createSequence,
  deleteProfileData,
  exportProfileData,
  insertLeadsChunk,
  listComplianceEventsKeyset,
  listSuppression,
  listTasksKeyset,
  purgeExpiredLeads,
  suppressProfile,
  unsuppressProfile,
} from "@/repositories/linkedin-sales-repository";
import { importLeadsFromText } from "./import.server";
import { prepareManualTasks } from "./scheduler.server";

let h: PgHarness;
let db: SupabaseClient;
let t: Tenant;

beforeAll(async () => {
  h = await createPgHarness();
  db = pgliteSupabase(h.db);
  t = await seedTenant(h.db, "li-compliance");
});
afterAll(async () => {
  await h.close();
});

const asOwner = <T>(fn: () => Promise<T>) => h.asUser(t.ownerId, fn);
const NOW = new Date("2026-09-16T10:00:00.000Z");

async function campaignWith(label: string, keys: string[]) {
  return asOwner(async () => {
    const list = await createLeadList({ workspaceId: t.workspaceId, name: label, sourceType: "customer_csv", db });
    await insertLeadsChunk({
      workspaceId: t.workspaceId, leadListId: list.id, db,
      leads: keys.map((k) => ({ profileKey: k, canonicalProfileUrl: `https://www.linkedin.com/in/${k}`, name: k, sourceType: "customer_csv" as const })),
    });
    const sequence = await createSequence({
      workspaceId: t.workspaceId, name: `${label}-seq`, db,
      steps: [
        { position: 1, kind: "manual_connection_request", template: "Hi {{name}}" },
        { position: 2, kind: "manual_linkedin_message", template: "Again {{name}}" },
      ],
    });
    const campaign = await createCampaign({
      workspaceId: t.workspaceId, leadListId: list.id, sequenceId: sequence.id, name: label,
      timezone: "UTC", windowStartMinute: 0, windowEndMinute: 1440, dailyTaskTarget: 50, db,
    });
    await activateCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db });
    return { list, campaign };
  });
}

const openTasks = (campaignId: string) =>
  asOwner(() => listTasksKeyset({ workspaceId: t.workspaceId, campaignId, states: ["ready", "opened", "copied"], pageSize: 100, db })).then((r) => r.rows);

describe("suppressing a profile reaches every campaign", () => {
  it("ends waiting memberships, cancels open tasks, marks every lead row, records one event; lifting it clears the flag only", async () => {
    const a = await campaignWith("supp-a", ["shared", "only-a"]);
    const b = await campaignWith("supp-b", ["shared", "only-b"]);
    await h.asServiceRole(() => prepareManualTasks({ db, now: NOW }));
    expect((await openTasks(a.campaign.id)).length).toBe(2);
    expect((await openTasks(b.campaign.id)).length).toBe(2);

    const out = await asOwner(() => suppressProfile({ workspaceId: t.workspaceId, profileKey: "shared", reason: "asked us", source: "unsubscribe", db }));
    // A member with an open task is still "waiting" (its next step is the open task), so both are ended now.
    expect(out).toEqual({ added: true, leadsMarked: 2, membersEnded: 2, tasksCancelled: 2 });
    expect((await openTasks(a.campaign.id)).map((x) => x.profile_url)).toEqual(["https://www.linkedin.com/in/only-a"]);
    expect((await openTasks(b.campaign.id)).map((x) => x.profile_url)).toEqual(["https://www.linkedin.com/in/only-b"]);
    const members = await h.db.query<{ state: string; state_reason: string | null }>(
      `select m.state, m.state_reason from public.linkedin_campaign_members m join public.linkedin_leads l on l.id = m.lead_id where l.profile_key = 'shared' order by m.created_at`,
    );
    expect(members.rows).toEqual([
      { state: "suppressed", state_reason: "suppression_list" },
      { state: "suppressed", state_reason: "suppression_list" },
    ]);
    const ca = await asOwner(() => campaignConservation({ workspaceId: t.workspaceId, campaignId: a.campaign.id, db }));
    expect(ca.membersTotal).toBe(2);
    expect(ca.suppressed).toBe(1);
    expect(ca.tasksCancelled).toBe(1);

    const events = await asOwner(() => listComplianceEventsKeyset({ workspaceId: t.workspaceId, pageSize: 5, db }));
    expect(events.rows[0].event_type).toBe("suppression_added");
    expect(events.rows[0].details).toMatchObject({ source: "unsubscribe", tasks_cancelled: 2, leads_marked: 2 });

    // Second add is idempotent and reports nothing new.
    const again = await asOwner(() => suppressProfile({ workspaceId: t.workspaceId, profileKey: "shared", source: "operator", db }));
    expect(again.added).toBe(false);
    expect(again.tasksCancelled).toBe(0);

    const lifted = await asOwner(() => unsuppressProfile({ workspaceId: t.workspaceId, profileKey: "shared", db }));
    expect(lifted).toEqual({ removed: true, leadsCleared: 2 });
    expect((await asOwner(() => listSuppression({ workspaceId: t.workspaceId, db }))).some((s) => s.profile_key === "shared")).toBe(false);
    // Cancelled tasks stay cancelled: lifting a suppression never un-ends anything.
    expect((await openTasks(a.campaign.id)).length).toBe(1);
  });

  it("a waiting member (no open task) is ended at once, and a later import of the same person is recorded do-not-contact", async () => {
    const a = await campaignWith("supp-wait", ["later"]);
    // Not yet dispatched: the member is waiting for its first step.
    const out = await asOwner(() => suppressProfile({ workspaceId: t.workspaceId, profileKey: "later", source: "operator", db }));
    expect(out.membersEnded).toBe(1);
    expect((await asOwner(() => campaignConservation({ workspaceId: t.workspaceId, campaignId: a.campaign.id, db }))).suppressed).toBe(1);
    await h.asServiceRole(() => prepareManualTasks({ db, now: NOW }));
    expect((await openTasks(a.campaign.id)).length).toBe(0);

    const list = await asOwner(() => createLeadList({ workspaceId: t.workspaceId, name: "supp-reimport", sourceType: "customer_pasted", db }));
    const imported = await asOwner(() => importLeadsFromText({ workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_pasted", text: "https://www.linkedin.com/in/later", db }));
    expect(imported.ok && imported.job.suppressed_count).toBe(1);
    expect(imported.ok && imported.job.inserted_count).toBe(0);
  });

  it("refuses a malformed key and an unknown source", async () => {
    await expect(asOwner(() => suppressProfile({ workspaceId: t.workspaceId, profileKey: "Not A Key!", source: "operator", db }))).rejects.toThrow();
    await expect(asOwner(() => suppressProfile({ workspaceId: t.workspaceId, profileKey: "fine", source: "bot" as never, db }))).rejects.toThrow();
  });
});

describe("a deletion request", () => {
  it("removes every row for the person, keeps only the key on the suppression list, and records counts with a hash instead of the key", async () => {
    const a = await campaignWith("del", ["gone", "stays"]);
    await h.asServiceRole(() => prepareManualTasks({ db, now: NOW }));
    const out = await asOwner(() => deleteProfileData({ workspaceId: t.workspaceId, profileKey: "gone", reason: "Data subject request 2026-09-16", db }));
    expect(out).toEqual({ leadsDeleted: 1, membersDeleted: 1, tasksDeleted: 1, suppressionKept: true });

    const rows = await h.db.query<{ n: number }>(`select count(*)::int as n from public.linkedin_leads where profile_key = 'gone'`);
    expect(rows.rows[0].n).toBe(0);
    const entry = (await asOwner(() => listSuppression({ workspaceId: t.workspaceId, db }))).find((s) => s.profile_key === "gone");
    expect(entry?.source).toBe("deletion_request");
    expect((await openTasks(a.campaign.id)).length).toBe(1);
    const conservation = await asOwner(() => campaignConservation({ workspaceId: t.workspaceId, campaignId: a.campaign.id, db }));
    expect(conservation.membersTotal).toBe(1);

    const events = await asOwner(() => listComplianceEventsKeyset({ workspaceId: t.workspaceId, pageSize: 3, db }));
    const ev = events.rows.find((e) => e.event_type === "deletion");
    expect(ev?.details).toMatchObject({ leads_deleted: 1, members_deleted: 1, tasks_deleted: 1 });
    expect(JSON.stringify(ev?.details)).not.toContain('"gone"');
    expect((ev?.details as { profile_key_sha256: string }).profile_key_sha256).toMatch(/^[0-9a-f]{64}$/);

    // The tool that lifts suppression does not lift a deletion request from the UI; the database allows it only explicitly.
    const reimport = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: a.list.id, sourceType: "customer_pasted", text: "https://www.linkedin.com/in/gone", db,
    }));
    expect(reimport.ok && reimport.job.suppressed_count).toBe(1);
  });
});

describe("retention purge", () => {
  it("deletes only leads past their date, in bounded batches, and records the count", async () => {
    const list = await asOwner(() => createLeadList({ workspaceId: t.workspaceId, name: "retention", sourceType: "customer_csv", db }));
    await asOwner(() => insertLeadsChunk({
      workspaceId: t.workspaceId, leadListId: list.id, db,
      leads: [
        { profileKey: "exp-1", canonicalProfileUrl: "https://www.linkedin.com/in/exp-1", sourceType: "customer_csv", retentionUntil: "2026-09-01" },
        { profileKey: "exp-2", canonicalProfileUrl: "https://www.linkedin.com/in/exp-2", sourceType: "customer_csv", retentionUntil: "2026-09-16" },
        { profileKey: "keep-1", canonicalProfileUrl: "https://www.linkedin.com/in/keep-1", sourceType: "customer_csv", retentionUntil: "2026-09-17" },
        { profileKey: "keep-2", canonicalProfileUrl: "https://www.linkedin.com/in/keep-2", sourceType: "customer_csv", retentionUntil: null },
      ],
    }));
    const first = await asOwner(() => purgeExpiredLeads({ workspaceId: t.workspaceId, today: "2026-09-16", limit: 1, db }));
    expect(first).toEqual({ deleted: 1, remaining: 1 });
    const second = await asOwner(() => purgeExpiredLeads({ workspaceId: t.workspaceId, today: "2026-09-16", limit: 1, db }));
    expect(second).toEqual({ deleted: 1, remaining: 0 });
    const left = await h.db.query<{ profile_key: string }>(`select profile_key from public.linkedin_leads where lead_list_id = $1 order by profile_key`, [list.id]);
    expect(left.rows.map((r) => r.profile_key)).toEqual(["keep-1", "keep-2"]);
    const events = await asOwner(() => listComplianceEventsKeyset({ workspaceId: t.workspaceId, pageSize: 2, db }));
    expect(events.rows.map((e) => e.event_type)).toEqual(["retention_purge", "retention_purge"]);
    expect(events.rows[1].details).toMatchObject({ deleted: 1, remaining: 1 });
  });
});

describe("export", () => {
  it("returns everything held about one profile and records the export without the key", async () => {
    const a = await campaignWith("export", ["ex-1"]);
    await h.asServiceRole(() => prepareManualTasks({ db, now: NOW }));
    const data = await asOwner(() => exportProfileData({ workspaceId: t.workspaceId, profileKey: "ex-1", db })) as {
      profile_key: string; leads: unknown[]; campaign_memberships: { campaign: string; state: string }[]; manual_tasks: { kind: string; state: string; draft_text: string }[]; suppression: unknown;
    };
    expect(data.profile_key).toBe("ex-1");
    expect(data.leads).toHaveLength(1);
    expect(data.campaign_memberships).toEqual([expect.objectContaining({ campaign: "export", state: "waiting" })]);
    expect(data.manual_tasks).toEqual([expect.objectContaining({ kind: "manual_connection_request", state: "ready", draft_text: "Hi ex-1" })]);
    expect(data.suppression).toBeNull();
    const events = await asOwner(() => listComplianceEventsKeyset({ workspaceId: t.workspaceId, pageSize: 1, db }));
    expect(events.rows[0].event_type).toBe("export");
    expect(JSON.stringify(events.rows[0].details)).not.toContain("ex-1");
    expect(a.campaign.id).toBeTruthy();
  });
});

describe("who may run the tools", () => {
  it("a viewer is refused by every tool; the service role has no execute privilege on any of them", async () => {
    await campaignWith("authz", ["z-1"]);
    for (const call of [
      () => suppressProfile({ workspaceId: t.workspaceId, profileKey: "z-1", source: "operator", db }),
      () => unsuppressProfile({ workspaceId: t.workspaceId, profileKey: "z-1", db }),
      () => deleteProfileData({ workspaceId: t.workspaceId, profileKey: "z-1", db }),
      () => purgeExpiredLeads({ workspaceId: t.workspaceId, today: "2026-09-16", db }),
      () => exportProfileData({ workspaceId: t.workspaceId, profileKey: "z-1", db }),
    ]) {
      await expect(h.asUser(t.viewerId, call)).rejects.toThrow(/forbidden|permission/i);
    }
    for (const fn of [
      "suppress_linkedin_profile($1, 'z-1', null, 'operator')",
      "unsuppress_linkedin_profile($1, 'z-1')",
      "delete_linkedin_profile_data($1, 'z-1', null)",
      "purge_linkedin_expired_leads($1, '2026-09-16', 10)",
      "export_linkedin_profile_data($1, 'z-1')",
    ]) {
      await expect(h.asServiceRole(() => h.db.query(`select * from public.${fn}`, [t.workspaceId]))).rejects.toThrow(/permission denied/i);
    }
    // Nothing happened.
    const rows = await h.db.query<{ n: number }>(`select count(*)::int as n from public.linkedin_leads where profile_key = 'z-1'`);
    expect(rows.rows[0].n).toBe(1);
  });
});
