/**
 * The task-preparation scheduler against real PostgreSQL (PGlite, all
 * migrations as shipped). The service role prepares; the operator
 * confirms; time is injected so days, windows and waits are exact.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinkedInTaskState } from "@/lib/supabase/types";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "@/test/pg/harness";
import { pgliteSupabase } from "@/test/pg/supabase-adapter";
import {
  activateCampaign,
  addSuppression,
  campaignConservation,
  cancelCampaign,
  confirmTask,
  createCampaign,
  createLeadList,
  createSequence,
  getCampaign,
  insertLeadsChunk,
  listMembersKeyset,
  listTasksKeyset,
  pauseCampaign,
  recordTaskCopied,
  recordTaskOpened,
  skipTask,
  type SequenceStepInput,
} from "@/repositories/linkedin-sales-repository";
import { orderCampaignsFairly, prepareManualTasks, ROUND_NOTE } from "./scheduler.server";

let h: PgHarness;
let db: SupabaseClient;
let t: Tenant;

beforeAll(async () => {
  h = await createPgHarness();
  db = pgliteSupabase(h.db);
  t = await seedTenant(h.db, "li-sched");
});
afterAll(async () => {
  await h.close();
});

const asOwner = <T>(fn: () => Promise<T>) => h.asUser(t.ownerId, fn);
const asWorker = <T>(fn: () => Promise<T>) => h.asServiceRole(fn);

/** 10:00 UTC on a weekday; the default window below is 09:00–18:00 UTC. */
const DAY1 = new Date("2026-09-16T10:00:00.000Z");
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

const ONE_STEP: SequenceStepInput[] = [
  { position: 1, kind: "manual_connection_request", template: "Hello {{name}}, I lead sales at Signal." },
];

async function setUp(input: {
  label: string;
  leads: number;
  steps?: SequenceStepInput[];
  target?: number;
  windowStart?: number;
  windowEnd?: number;
  timezone?: string;
  activate?: boolean;
}) {
  return asOwner(async () => {
    const list = await createLeadList({ workspaceId: t.workspaceId, name: input.label, sourceType: "customer_csv", db });
    await insertLeadsChunk({
      workspaceId: t.workspaceId, leadListId: list.id, db,
      leads: Array.from({ length: input.leads }, (_, i) => ({
        profileKey: `${input.label}-${i}`, canonicalProfileUrl: `https://www.linkedin.com/in/${input.label}-${i}`,
        name: `Person ${i}`, sourceType: "customer_csv" as const,
      })),
    });
    const sequence = await createSequence({ workspaceId: t.workspaceId, name: `${input.label}-seq`, steps: input.steps ?? ONE_STEP, db });
    const campaign = await createCampaign({
      workspaceId: t.workspaceId, leadListId: list.id, sequenceId: sequence.id, name: input.label,
      timezone: input.timezone ?? "UTC", windowStartMinute: input.windowStart ?? 540, windowEndMinute: input.windowEnd ?? 1080,
      dailyTaskTarget: input.target ?? 20, db,
    });
    const activation = input.activate === false ? null : await activateCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db });
    return { list, sequence, campaign, activation };
  });
}

const ALL_TASK_STATES: LinkedInTaskState[] = ["scheduled", "ready", "opened", "copied", "operator_confirmed", "skipped", "cancelled"];
const tasksOf = (campaignId: string, states: LinkedInTaskState[] = ALL_TASK_STATES) =>
  asOwner(() => listTasksKeyset({ workspaceId: t.workspaceId, campaignId, states, pageSize: 200, db })).then((r) => r.rows);

/** PostgREST serialises a `date` as YYYY-MM-DD; PGlite hands back a Date. Same day either way. */
const localDay = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10));

const membersOf = (campaignId: string) =>
  asOwner(() => listMembersKeyset({ workspaceId: t.workspaceId, campaignId, pageSize: 200, db })).then((r) => r.rows);

const conservation = (campaignId: string) => asOwner(() => campaignConservation({ workspaceId: t.workspaceId, campaignId, db }));

describe("daily target, window and re-entry", () => {
  it("prepares up to the daily target inside the window; a replayed tick prepares nothing more; the next local day prepares again", async () => {
    const { campaign } = await setUp({ label: "target", leads: 10, target: 3 });
    const r1 = await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    expect(r1.note).toBe(ROUND_NOTE);
    const mine = r1.served.find((s) => s.campaignId === campaign.id);
    expect(mine?.budget).toBe(3);
    expect(mine?.released).toBe(3);
    expect((await tasksOf(campaign.id, ["ready"])).length).toBe(3);

    // At-least-once delivery: the same instant again, and a minute later.
    const r2 = await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    const r3 = await asWorker(() => prepareManualTasks({ db, now: new Date(DAY1.getTime() + 60_000) }));
    for (const r of [r2, r3]) {
      expect(r.deferred.find((d) => d.campaignId === campaign.id)?.reason).toBe("daily_target_reached");
    }
    expect((await tasksOf(campaign.id)).length).toBe(3);

    const r4 = await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 1) }));
    expect(r4.served.find((s) => s.campaignId === campaign.id)?.released).toBe(3);
    expect((await tasksOf(campaign.id)).length).toBe(6);
    // Every task carries the local day it was prepared on.
    const days = new Set((await tasksOf(campaign.id)).map((x) => localDay(x.local_date)));
    expect([...days].sort()).toEqual(["2026-09-16", "2026-09-17"]);

    // Skipped and cancelled tasks still count toward the day: the target
    // bounds what Signal prepares, not what the operator confirms.
    const c = await conservation(campaign.id);
    expect(c.membersTotal).toBe(10);
    expect(c.waiting + c.completed + c.suppressed + c.operatorSkipped + c.structurallyInvalid + c.cancelled).toBe(10);
  });

  it("outside the working window nothing is prepared, and the campaign's timezone decides", async () => {
    const { campaign } = await setUp({ label: "window", leads: 3, timezone: "Pacific/Auckland" });
    // 10:00 UTC is 22:00 in Auckland (NZST, September): outside 09:00–18:00.
    const r = await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    expect(r.deferred.find((d) => d.campaignId === campaign.id)?.reason).toBe("outside_window");
    expect((await tasksOf(campaign.id)).length).toBe(0);
    // 22:00 UTC is 10:00 in Auckland the next day: inside.
    const r2 = await asWorker(() => prepareManualTasks({ db, now: new Date("2026-09-16T22:00:00.000Z") }));
    const mine = r2.served.find((s) => s.campaignId === campaign.id);
    expect(mine?.released).toBe(3);
    expect(mine?.localDate).toBe("2026-09-17");
  });

  it("never prepares a second active task for a member, even when asked twice in one instant", async () => {
    const { campaign } = await setUp({ label: "oneactive", leads: 2, target: 50 });
    await Promise.all([
      asWorker(() => prepareManualTasks({ db, now: DAY1 })),
      asWorker(() => prepareManualTasks({ db, now: DAY1 })),
    ]);
    const tasks = await tasksOf(campaign.id);
    expect(tasks.length).toBe(2);
    expect(new Set(tasks.map((x) => x.campaign_member_id)).size).toBe(2);
    // And the index refuses a hand-made second one, even for the service role.
    const first = tasks[0];
    await expect(
      h.asServiceRole(() => h.db.query(
        `insert into public.linkedin_manual_tasks
           (workspace_id, campaign_id, campaign_member_id, sequence_step_id, kind, state, profile_url, local_date, available_at)
         values ($1, $2, $3, $4, $5, 'ready', $6, '2026-09-16', now())`,
        [t.workspaceId, campaign.id, first.campaign_member_id, first.sequence_step_id, first.kind, first.profile_url],
      )),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe("fairness", () => {
  it("orders never-served campaigns first, then least recently served, then id", () => {
    const rows = [
      { id: "c", last_dispatched_at: "2026-09-16T09:00:00Z" },
      { id: "b", last_dispatched_at: null },
      { id: "a", last_dispatched_at: "2026-09-16T08:00:00Z" },
      { id: "d", last_dispatched_at: null },
      { id: "e", last_dispatched_at: "not a date" },
    ];
    expect(orderCampaignsFairly(rows).map((r) => r.id)).toEqual(["b", "d", "e", "a", "c"]);
  });

  it("persists the rotation before the work, so a served campaign goes behind campaigns that have never been served", async () => {
    const a = await setUp({ label: "fair-a", leads: 1, target: 1 });
    const first = await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    expect(first.served.some((s) => s.campaignId === a.campaign.id)).toBe(true);
    const stamped = await asOwner(() => getCampaign({ workspaceId: t.workspaceId, campaignId: a.campaign.id, db }));
    expect(stamped?.last_dispatched_at && Date.parse(stamped.last_dispatched_at)).toBe(DAY1.getTime());

    const b = await setUp({ label: "fair-b", leads: 1, target: 1 });
    const c = await setUp({ label: "fair-c", leads: 1, target: 1 });
    const later = new Date(DAY1.getTime() + 5 * 60_000);
    const second = await asWorker(() => prepareManualTasks({ db, now: later }));
    const order = second.served.map((s) => s.campaignId).filter((id) => [a.campaign.id, b.campaign.id, c.campaign.id].includes(id));
    const expected = [b.campaign.id, c.campaign.id].sort();
    expect(order.slice(0, 2)).toEqual(expected);
    // "a" is considered last among these three (its day target is spent, so it is deferred, not served).
    expect(second.deferred.find((d) => d.campaignId === a.campaign.id)?.reason).toBe("daily_target_reached");
  });
});

describe("membership, suppression and explainable end states", () => {
  it("freezes membership at activation: a lead added to the list afterwards is not a member", async () => {
    const { campaign, list } = await setUp({ label: "frozen", leads: 2 });
    await asOwner(() => insertLeadsChunk({
      workspaceId: t.workspaceId, leadListId: list.id, db,
      leads: [{ profileKey: "frozen-late", canonicalProfileUrl: "https://www.linkedin.com/in/frozen-late", sourceType: "customer_csv" }],
    }));
    await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    expect((await membersOf(campaign.id)).length).toBe(2);
    expect((await conservation(campaign.id)).membersTotal).toBe(2);
  });

  it("suppression wins at activation and at release, with the reason recorded and no task prepared", async () => {
    await asOwner(() => addSuppression({
      workspaceId: t.workspaceId, profileKey: "supp-0", canonicalProfileUrl: "https://www.linkedin.com/in/supp-0", source: "operator", db,
    }));
    const { campaign, activation } = await setUp({ label: "supp", leads: 3 });
    expect(activation?.membersSuppressed).toBe(1);
    expect(activation?.membersWaiting).toBe(2);
    // Suppressed after activation, before any task exists.
    await asOwner(() => addSuppression({
      workspaceId: t.workspaceId, profileKey: "supp-1", canonicalProfileUrl: "https://www.linkedin.com/in/supp-1", source: "unsubscribe", db,
    }));
    const r = await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    const mine = r.served.find((s) => s.campaignId === campaign.id);
    expect(mine?.suppressed).toBe(1);
    expect(mine?.released).toBe(1);
    const members = await membersOf(campaign.id);
    const byState = Object.fromEntries(members.map((m) => [m.state, (members.filter((x) => x.state === m.state)).length]));
    expect(byState.suppressed).toBe(2);
    expect(members.filter((m) => m.state === "suppressed").every((m) => m.state_reason === "suppression_list")).toBe(true);
    const tasks = await tasksOf(campaign.id);
    expect(tasks.length).toBe(1);
    expect(tasks[0].profile_url).toBe("https://www.linkedin.com/in/supp-2");
  });

  it("a sequence with a position gap ends the member as structurally_invalid with a reason, never a guess", async () => {
    const { campaign } = await setUp({
      label: "gap", leads: 1,
      steps: [
        { position: 1, kind: "manual_profile_review", template: "Look first." },
        { position: 3, kind: "manual_linkedin_message", template: "Hi {{name}}" },
      ],
    });
    await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    const [task] = await tasksOf(campaign.id, ["ready"]);
    const confirmed = await asOwner(() => confirmTask({ workspaceId: t.workspaceId, taskId: task.id, db }));
    expect(confirmed.ok).toBe(true);
    const r = await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 1) }));
    expect(r.served.find((s) => s.campaignId === campaign.id)?.invalid).toBe(1);
    const [member] = await membersOf(campaign.id);
    expect(member.state).toBe("structurally_invalid");
    expect(member.state_reason).toBe("sequence_position_gap");
    expect((await tasksOf(campaign.id)).length).toBe(1);
  });

  it("an email step is refused at activation because no email integration is authorized", async () => {
    const { activation, campaign } = await setUp({
      label: "email", leads: 1,
      steps: [{ position: 1, kind: "authorized_email", template: "Hello {{name}}" }],
    });
    expect(activation?.ok).toBe(false);
    expect(activation?.refusedReason).toBe("email_integration_unavailable");
    expect((await asOwner(() => getCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db })))?.status).toBe("draft");
  });
});

describe("the operator's side: opening and copying never complete; confirming and skipping do", () => {
  it("walks a connection → wait → message sequence with the operator confirming each task", async () => {
    const { campaign } = await setUp({
      label: "walk", leads: 1,
      steps: [
        { position: 1, kind: "manual_connection_request", template: "Hello {{name}}" },
        { position: 2, kind: "wait", waitDays: 2 },
        { position: 3, kind: "manual_linkedin_message", template: "Following up, {{name}} at {{company}}." },
      ],
    });
    await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    let [task] = await tasksOf(campaign.id, ["ready"]);
    expect(task.kind).toBe("manual_connection_request");
    expect(task.draft_text).toBe("Hello Person 0");

    // Opening and copying are recordings, not completion.
    const opened = await asOwner(() => recordTaskOpened({ workspaceId: t.workspaceId, taskId: task.id, db }));
    expect(opened?.state).toBe("opened");
    const copied = await asOwner(() => recordTaskCopied({ workspaceId: t.workspaceId, taskId: task.id, db }));
    expect(copied?.state).toBe("copied");
    expect(copied?.operator_confirmed_at).toBeNull();
    let [member] = await membersOf(campaign.id);
    expect(member.state).toBe("waiting");
    expect(member.current_position).toBe(1);
    // A tick in between prepares nothing new for this member.
    await asWorker(() => prepareManualTasks({ db, now: new Date(DAY1.getTime() + 60_000) }));
    expect((await tasksOf(campaign.id)).length).toBe(1);

    // Only the operator's confirmation advances the member.
    const confirmed = await asOwner(() => confirmTask({ workspaceId: t.workspaceId, taskId: task.id, db }));
    expect(confirmed.ok).toBe(true);
    [member] = await membersOf(campaign.id);
    expect(member.current_position).toBe(2);

    // The wait step is consumed by the scheduler and sets the availability.
    const r2 = await asWorker(() => prepareManualTasks({ db, now: new Date(DAY1.getTime() + 120_000) }));
    expect(r2.served.find((s) => s.campaignId === campaign.id)?.waitsAdvanced).toBe(1);
    [member] = await membersOf(campaign.id);
    expect(member.current_position).toBe(3);
    expect(member.next_step_available_at && Date.parse(member.next_step_available_at)).toBe(DAY1.getTime() + 120_000 + 2 * 86_400_000);

    // Too early: nothing. On time: the message task, rendered.
    await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 1) }));
    expect((await tasksOf(campaign.id)).length).toBe(1);
    await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 3) }));
    const all = await tasksOf(campaign.id);
    expect(all.length).toBe(2);
    task = all.find((x) => x.kind === "manual_linkedin_message")!;
    expect(task.state).toBe("ready");
    expect(task.draft_text).toBe("Following up, Person 0 at .");

    // Confirming the last step completes the member and, with nobody left, the campaign.
    await asOwner(() => confirmTask({ workspaceId: t.workspaceId, taskId: task.id, db }));
    [member] = await membersOf(campaign.id);
    expect(member.state).toBe("completed");
    const r3 = await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 3) }));
    expect(r3.served.find((s) => s.campaignId === campaign.id)?.campaignCompleted).toBe(true);
    expect((await asOwner(() => getCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db })))?.status).toBe("completed");
  });

  it("skipping needs a reason and ends the member as operator_skipped", async () => {
    const { campaign } = await setUp({ label: "skip", leads: 1 });
    await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    const [task] = await tasksOf(campaign.id, ["ready"]);
    const noReason = await asOwner(() => skipTask({ workspaceId: t.workspaceId, taskId: task.id, reason: "   ", db }));
    expect(noReason.ok).toBe(false);
    const skipped = await asOwner(() => skipTask({ workspaceId: t.workspaceId, taskId: task.id, reason: "Not a fit for this campaign.", db }));
    expect(skipped.ok).toBe(true);
    const [member] = await membersOf(campaign.id);
    expect(member.state).toBe("operator_skipped");
    expect(member.state_reason).toBe("Not a fit for this campaign.");
    // A skipped task cannot be confirmed afterwards.
    const late = await asOwner(() => confirmTask({ workspaceId: t.workspaceId, taskId: task.id, db }));
    expect(late.ok).toBe(false);
  });

  it("the service role can prepare tasks but cannot confirm, skip, open or copy one", async () => {
    const { campaign } = await setUp({ label: "role", leads: 1 });
    await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    const [task] = await tasksOf(campaign.id, ["ready"]);
    await expect(h.asServiceRole(() => h.db.query(`select * from public.confirm_linkedin_task($1, $2)`, [t.workspaceId, task.id])))
      .rejects.toThrow(/permission denied/i);
    await expect(h.asServiceRole(() => h.db.query(`select * from public.skip_linkedin_task($1, $2, 'x')`, [t.workspaceId, task.id])))
      .rejects.toThrow(/permission denied/i);
    // The scheduler module never imports an operator function.
    const src = readFileSync(path.join(__dirname, "scheduler.server.ts"), "utf8");
    for (const name of ["confirmTask", "skipTask", "recordTaskOpened", "recordTaskCopied", "suppressFromTask"]) {
      expect(src, name).not.toContain(name);
    }
  });
});

describe("pause, resume, cancel", () => {
  it("a paused campaign is not considered; resume keeps its membership; cancel ends open tasks and waiting members", async () => {
    const { campaign } = await setUp({ label: "lifecycle", leads: 4, target: 2 });
    await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    expect((await tasksOf(campaign.id, ["ready"])).length).toBe(2);

    expect((await asOwner(() => pauseCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db })))?.status).toBe("paused");
    const paused = await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 1) }));
    expect(paused.served.some((s) => s.campaignId === campaign.id)).toBe(false);
    expect(paused.deferred.some((d) => d.campaignId === campaign.id)).toBe(false);

    const resumed = await asOwner(() => activateCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db }));
    expect(resumed.ok).toBe(true);
    expect((await membersOf(campaign.id)).length).toBe(4);
    await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 1) }));
    expect((await tasksOf(campaign.id, ["ready"])).length).toBe(4);

    const cancelled = await asOwner(() => cancelCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db }));
    expect(cancelled.ok).toBe(true);
    expect(cancelled.tasksCancelled).toBe(4);
    const c = await conservation(campaign.id);
    expect(c.cancelled).toBe(4);
    expect(c.tasksCancelled).toBe(4);
    expect(c.tasksOpen).toBe(0);
    expect(c.membersTotal).toBe(4);
    const members = await membersOf(campaign.id);
    expect(members.every((m) => m.state === "cancelled" && m.state_reason)).toBe(true);
    // Cancelled is final: the campaign is not considered again.
    const after = await asWorker(() => prepareManualTasks({ db, now: plusDays(DAY1, 2) }));
    expect(after.served.some((s) => s.campaignId === campaign.id)).toBe(false);
  });
});

describe("fail closed on a step kind Signal does not know", () => {
  it("a kind that slipped past the closed set (constraint dropped to simulate a future migration) ends the member structurally_invalid and prepares nothing", async () => {
    // Simulate: a later migration adds a kind, the scheduler was not taught it.
    await h.db.exec(`alter table public.linkedin_sequence_steps drop constraint linkedin_sequence_steps_kind_check`);
    const { campaign, sequence } = await setUp({ label: "unknown", leads: 1, activate: false });
    await h.db.query(`delete from public.linkedin_sequence_steps where sequence_id = $1`, [sequence.id]);
    await h.db.query(
      `insert into public.linkedin_sequence_steps (workspace_id, sequence_id, position, kind, wait_days, template)
       values ($1, $2, 1, 'automatic_send', 0, 'x')`,
      [t.workspaceId, sequence.id],
    );
    const activation = await asOwner(() => activateCampaign({ workspaceId: t.workspaceId, campaignId: campaign.id, db }));
    expect(activation.ok).toBe(true);
    const r = await asWorker(() => prepareManualTasks({ db, now: DAY1 }));
    expect(r.served.find((s) => s.campaignId === campaign.id)?.invalid).toBe(1);
    expect(r.served.find((s) => s.campaignId === campaign.id)?.released).toBe(0);
    const [member] = await membersOf(campaign.id);
    expect(member.state).toBe("structurally_invalid");
    expect(member.state_reason).toBe("unknown_step_kind:automatic_send");
    expect((await tasksOf(campaign.id)).length).toBe(0);
  });
});

describe("structural", () => {
  it("no OFFSET paging anywhere in the LinkedIn Sales code or migrations", () => {
    const files = [
      path.resolve(__dirname, "scheduler.server.ts"),
      path.resolve(__dirname, "import.server.ts"),
      path.resolve(__dirname, "../../repositories/linkedin-sales-repository.ts"),
      ...readdirSync(path.resolve(__dirname, "../../../supabase/migrations"))
        .filter((f) => f.includes("linkedin_sales") || f.includes("linkedin_import"))
        .map((f) => path.resolve(__dirname, "../../../supabase/migrations", f)),
    ];
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\boffset\b/i);
      expect(src, f).not.toMatch(/\.range\(/);
    }
  });
});
