import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase F7.2 — cancelApprovalAction regression guards.
 *
 * Asserts the lifecycle gates around reverting an approved or
 * scheduled plan_item back to pending_approval:
 *
 *   - approved (held)              → reverts, no execution side-effects
 *   - scheduled + pre-dispatch     → cancels execution_item + reverts
 *   - scheduled + running          → REFUSE (race-safe)
 *   - scheduled + completed        → REFUSE (already published)
 *   - published / rejected / paused / skipped / backlog / draft /
 *     pending_approval             → REFUSE with actionable message
 *
 * Server-action surface is tested via mocked repositories — the
 * action itself owns the lifecycle logic and is the unit under test.
 */

// ---- vi.hoisted captures so the mocks reach module scope ----

const hoisted = vi.hoisted(() => {
  return {
    workspaceMembership: { workspace: { id: "ws-1" } },
    planItemFixture: {
      id: "pi-1",
      workspaceId: "ws-1",
      title: "An article",
      status: "approved" as
        | "draft"
        | "pending_approval"
        | "approved"
        | "scheduled"
        | "published"
        | "rejected"
        | "paused"
        | "skipped"
        | "backlog",
      weeklyPlanId: "plan-1",
    },
    executionItemsFixture: [] as Array<{ id: string; status: string }>,
    updatePlanItemStatusMock: vi.fn(),
    listExecutionItemsByPlanItemIdsMock: vi.fn(),
    activityMock: vi.fn(),
    supabaseUpdateMock: vi.fn(),
  };
});

vi.mock("@/repositories/workspace-repository", () => ({
  getPrimaryWorkspace: vi.fn(async () => hoisted.workspaceMembership),
}));

vi.mock("@/repositories/weekly-plan-repository", () => ({
  getPlanItemById: vi.fn(async () => ({
    ...hoisted.planItemFixture,
    scheduledAt: null,
    metadata: {},
  })),
  // Hoisted version is captured separately so each test can reset.
  updatePlanItemStatus: hoisted.updatePlanItemStatusMock.mockImplementation(
    async ({ status }: { status: string }) => {
      // The action calls getPlanItemById AGAIN after the status flip
      // (`fresh`) — mutate the fixture so the re-read sees the new
      // status. This mirrors a successful DB write.
      hoisted.planItemFixture.status =
        status as typeof hoisted.planItemFixture.status;
      return undefined;
    },
  ),
}));

vi.mock("@/repositories/execution-item-repository", () => ({
  listExecutionItemsByPlanItemIds:
    hoisted.listExecutionItemsByPlanItemIdsMock.mockImplementation(
      async () => hoisted.executionItemsFixture,
    ),
}));

vi.mock("@/repositories/activity-repository", () => ({
  recordActivity: hoisted.activityMock,
}));

// Supabase: only used for the execution_items atomic cancel update.
vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => ({
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({
            in: () => ({
              select: () => ({
                maybeSingle: hoisted.supabaseUpdateMock,
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

// Observability + errors are noisy in the action; stub them out.
vi.mock("@/core/observability/approval-events", () => ({
  emitApprovalSchedulePreserved: vi.fn(),
  emitApprovalStateAssertionFailed: vi.fn(),
  emitApprovalTransitionCommitted: vi.fn(),
  emitApprovalTransitionFailed: vi.fn(),
  emitApprovalTransitionStarted: vi.fn(),
}));
vi.mock("@/core/observability/schedule-events", () => ({
  emitScheduleParseInvalid: vi.fn(),
  emitScheduleSaveRejected: vi.fn(),
  emitScheduleSaveSuccess: vi.fn(),
  emitScheduleSourceChange: vi.fn(),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// ---- Imports under test ----

import { cancelApprovalAction } from "./_actions";

function formData(itemId: string): FormData {
  const fd = new FormData();
  fd.append("item_id", itemId);
  return fd;
}

function resetFixtures() {
  hoisted.planItemFixture.status = "approved";
  hoisted.executionItemsFixture = [];
  hoisted.supabaseUpdateMock.mockReset();
  hoisted.supabaseUpdateMock.mockResolvedValue({
    data: { id: "exec-1", status: "cancelled" },
    error: null,
  });
  hoisted.activityMock.mockReset();
  hoisted.activityMock.mockResolvedValue(undefined);
  hoisted.updatePlanItemStatusMock.mockClear();
  hoisted.listExecutionItemsByPlanItemIdsMock.mockClear();
}

beforeEach(resetFixtures);

afterEach(() => {
  vi.clearAllMocks();
});

const PREV: never = undefined as never;

// ---- Tests ----

describe("cancelApprovalAction — happy paths", () => {
  it("approved (held, no execution_item) → pending_approval", async () => {
    hoisted.planItemFixture.status = "approved";
    hoisted.executionItemsFixture = [];
    const out = await cancelApprovalAction(PREV, formData("pi-1"));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.status).toBe("pending_approval");
      expect(out.cancelledExecutionItemCount).toBe(0);
    }
    expect(hoisted.updatePlanItemStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending_approval" }),
    );
    expect(hoisted.supabaseUpdateMock).not.toHaveBeenCalled();
  });

  it("scheduled + execution_item in pending_authorization → both transition", async () => {
    hoisted.planItemFixture.status = "scheduled";
    hoisted.executionItemsFixture = [
      { id: "exec-1", status: "pending_authorization" },
    ];
    const out = await cancelApprovalAction(PREV, formData("pi-1"));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.status).toBe("pending_approval");
      expect(out.cancelledExecutionItemCount).toBe(1);
    }
    expect(hoisted.supabaseUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("scheduled + execution_item in scheduled state → cancel + revert", async () => {
    hoisted.planItemFixture.status = "scheduled";
    hoisted.executionItemsFixture = [
      { id: "exec-1", status: "scheduled" },
    ];
    const out = await cancelApprovalAction(PREV, formData("pi-1"));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.cancelledExecutionItemCount).toBe(1);
    }
  });
});

describe("cancelApprovalAction — race-safe refusals", () => {
  it("scheduled + execution_item RUNNING → REFUSE, no DB writes", async () => {
    hoisted.planItemFixture.status = "scheduled";
    hoisted.executionItemsFixture = [
      { id: "exec-1", status: "running" },
    ];
    const out = await cancelApprovalAction(PREV, formData("pi-1"));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/in flight/i);
    }
    expect(hoisted.updatePlanItemStatusMock).not.toHaveBeenCalled();
    expect(hoisted.supabaseUpdateMock).not.toHaveBeenCalled();
  });

  it("scheduled + execution_item COMPLETED → REFUSE", async () => {
    hoisted.planItemFixture.status = "scheduled";
    hoisted.executionItemsFixture = [
      { id: "exec-1", status: "completed" },
    ];
    const out = await cancelApprovalAction(PREV, formData("pi-1"));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/already been published/i);
    }
  });
});

describe("cancelApprovalAction — terminal/illegal source states", () => {
  const refusedSources = [
    "published",
    "rejected",
    "paused",
    "skipped",
    "backlog",
    "draft",
    "pending_approval",
  ] as const;

  for (const source of refusedSources) {
    it(`status="${source}" → REFUSE with actionable message`, async () => {
      hoisted.planItemFixture.status = source;
      const out = await cancelApprovalAction(PREV, formData("pi-1"));
      expect(out.ok).toBe(false);
      expect(hoisted.updatePlanItemStatusMock).not.toHaveBeenCalled();
      expect(hoisted.supabaseUpdateMock).not.toHaveBeenCalled();
    });
  }
});

describe("cancelApprovalAction — input validation", () => {
  it("missing item_id → actionFail", async () => {
    const fd = new FormData();
    const out = await cancelApprovalAction(PREV, fd);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatch(/Missing item id/i);
    }
  });
});
