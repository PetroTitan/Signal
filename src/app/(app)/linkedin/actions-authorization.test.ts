/**
 * The server actions' own gate, with the repository mocked: who is
 * refused before any query, what a confirmation requires, and that the
 * "opened" and "copied" recordings never reach the confirm function.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  activateCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
  confirmTask: vi.fn(),
  createCampaign: vi.fn(),
  createLeadList: vi.fn(),
  createSequence: vi.fn(),
  getCampaign: vi.fn(),
  getTask: vi.fn(),
  pauseCampaign: vi.fn(),
  recordComplianceEvent: vi.fn(),
  recordTaskCopied: vi.fn(),
  recordTaskOpened: vi.fn(),
  skipTask: vi.fn(),
  suppressFromTask: vi.fn(),
}));
vi.mock("@/repositories/linkedin-sales-repository", () => repo);
vi.mock("@/core/linkedin-sales/import.server", () => ({ IMPORT_MAX_BYTES: 1_000_000, importLeadsFromText: vi.fn() }));
vi.mock("@/repositories/activity-repository", () => ({ recordActivity: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const session = vi.hoisted(() => ({ role: "owner", user: { id: "u-1" } as { id: string } | null }));
vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: async () => ({ data: { user: session.user } }) } }),
}));
vi.mock("@/repositories/workspace-repository", () => ({
  getPrimaryWorkspace: async () => ({ workspace: { id: "ws-1" }, role: session.role }),
}));

import {
  confirmTaskAction,
  createLeadListAction,
  recordCopiedAction,
  recordOpenedAction,
  skipTaskAction,
  suppressFromTaskAction,
  cancelCampaignAction,
} from "./_actions";

const TASK = "11111111-1111-4111-8111-111111111111";
const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const EMPTY = { ok: false as const, error: "" };

beforeEach(() => {
  session.role = "owner";
  session.user = { id: "u-1" };
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.confirmTask.mockResolvedValue({ ok: true, refusedReason: null, memberState: "waiting" });
  repo.skipTask.mockResolvedValue({ ok: true, refusedReason: null });
  repo.suppressFromTask.mockResolvedValue({ ok: true, refusedReason: null });
  repo.recordTaskOpened.mockResolvedValue({ id: TASK });
  repo.recordTaskCopied.mockResolvedValue({ id: TASK });
  repo.cancelCampaign.mockResolvedValue({ ok: true, refusedReason: null, tasksCancelled: 1, membersCancelled: 1 });
  repo.getCampaign.mockResolvedValue({ id: TASK, name: "c" });
});

describe("who may act", () => {
  it("a signed-out request is refused before any repository call", async () => {
    session.user = null;
    const r = await confirmTaskAction(EMPTY, fd({ task_id: TASK, attest: "on" }));
    expect(r.ok).toBe(false);
    expect(repo.confirmTask).not.toHaveBeenCalled();
  });

  it.each(["viewer", "reviewer"])("a %s can view but not create, confirm, skip or suppress", async (r) => {
    session.role = r;
    for (const call of [
      () => createLeadListAction(EMPTY, fd({ name: "x", source_type: "customer_csv" })),
      () => confirmTaskAction(EMPTY, fd({ task_id: TASK, attest: "on" })),
      () => skipTaskAction(EMPTY, fd({ task_id: TASK, reason: "no" })),
      () => suppressFromTaskAction(EMPTY, fd({ task_id: TASK, confirm: "on" })),
      () => recordOpenedAction(TASK),
      () => recordCopiedAction(TASK),
    ]) {
      const out = await call();
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/owner, admin or editor/);
    }
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(["editor", "admin", "owner"])("an %s reaches the repository", async (r) => {
    session.role = r;
    const out = await confirmTaskAction(EMPTY, fd({ task_id: TASK, attest: "on" }));
    expect(out.ok).toBe(true);
    expect(repo.confirmTask).toHaveBeenCalledWith({ workspaceId: "ws-1", taskId: TASK });
  });
});

describe("what a confirmation needs", () => {
  it("refuses without the operator's own statement", async () => {
    const out = await confirmTaskAction(EMPTY, fd({ task_id: TASK }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/yourself/);
    expect(repo.confirmTask).not.toHaveBeenCalled();
  });

  it("a skip needs a reason", async () => {
    const out = await skipTaskAction(EMPTY, fd({ task_id: TASK, reason: "   " }));
    expect(out.ok).toBe(false);
    expect(repo.skipTask).not.toHaveBeenCalled();
  });

  it("suppression and cancellation need the confirmation tick", async () => {
    expect((await suppressFromTaskAction(EMPTY, fd({ task_id: TASK }))).ok).toBe(false);
    expect(repo.suppressFromTask).not.toHaveBeenCalled();
    expect((await cancelCampaignAction(EMPTY, fd({ campaign_id: TASK }))).ok).toBe(false);
    expect(repo.cancelCampaign).not.toHaveBeenCalled();
  });
});

describe("opening and copying are recordings", () => {
  it("recordOpenedAction records an open and an event, and never confirms", async () => {
    const out = await recordOpenedAction(TASK);
    expect(out.ok).toBe(true);
    expect(repo.recordTaskOpened).toHaveBeenCalledTimes(1);
    expect(repo.recordComplianceEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "task_opened" }));
    expect(repo.confirmTask).not.toHaveBeenCalled();
    expect(out.ok && out.message).toMatch(/Nothing was sent/);
  });

  it("recordCopiedAction records a copy and never confirms", async () => {
    const out = await recordCopiedAction(TASK);
    expect(repo.recordTaskCopied).toHaveBeenCalledTimes(1);
    expect(repo.recordComplianceEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "task_copied" }));
    expect(repo.confirmTask).not.toHaveBeenCalled();
    expect(out.ok && out.message).toMatch(/Nothing was sent/);
  });
});
