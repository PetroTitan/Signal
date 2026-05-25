import { afterEach, describe, expect, it } from "vitest";
import {
  __setApprovalEventSink,
  emitApprovalRedirectBlocked,
  emitApprovalSchedulePreserved,
  emitApprovalScheduleMutationBlocked,
  emitApprovalStateAssertionFailed,
  emitApprovalTransitionCommitted,
  emitApprovalTransitionFailed,
  emitApprovalTransitionStarted,
  type ApprovalEventName,
  type ApprovalEventPayload,
} from "./approval-events";

interface Captured {
  name: ApprovalEventName;
  payload: ApprovalEventPayload;
}

function withSink<T>(run: (cap: Captured[]) => T): T {
  const captured: Captured[] = [];
  __setApprovalEventSink((name, payload) =>
    captured.push({ name, payload }),
  );
  try {
    return run(captured);
  } finally {
    __setApprovalEventSink(null);
  }
}

afterEach(() => {
  __setApprovalEventSink(null);
});

describe("approval-events emitters", () => {
  it("transition_started carries action + workspace + before-state", () => {
    withSink((cap) => {
      emitApprovalTransitionStarted({
        action: "approve_and_hold",
        workspaceId: "w1",
        planId: "p1",
        planItemId: "i1",
        beforeStatus: "pending_approval",
        beforeScheduledAt: "2026-05-20T20:01:00.000Z",
      });
      expect(cap).toHaveLength(1);
      expect(cap[0].name).toBe("approval_transition_started");
      expect(cap[0].payload.workspaceId).toBe("w1");
      expect(cap[0].payload.beforeStatus).toBe("pending_approval");
      expect(cap[0].payload.mutationBlocked).toBe(false);
    });
  });

  it("transition_committed records before+after status and schedule", () => {
    withSink((cap) => {
      emitApprovalTransitionCommitted({
        action: "approve_and_hold",
        workspaceId: "w1",
        planItemId: "i1",
        beforeStatus: "pending_approval",
        afterStatus: "approved",
        beforeScheduledAt: "2026-05-20T20:01:00.000Z",
        afterScheduledAt: "2026-05-20T20:01:00.000Z",
      });
      expect(cap[0].payload.afterStatus).toBe("approved");
      expect(cap[0].payload.beforeScheduledAt).toBe(
        cap[0].payload.afterScheduledAt,
      );
      expect(cap[0].payload.mutationBlocked).toBe(false);
    });
  });

  it.each<{
    emit: () => void;
    name: ApprovalEventName;
  }>([
    {
      emit: () =>
        emitApprovalTransitionFailed({
          action: "approve_and_hold",
          workspaceId: "w",
          failureReason: "db_error",
        }),
      name: "approval_transition_failed",
    },
    {
      emit: () =>
        emitApprovalStateAssertionFailed({
          action: "approve_and_hold",
          workspaceId: "w",
          failureReason: "status mismatch",
        }),
      name: "approval_state_assertion_failed",
    },
    {
      emit: () =>
        emitApprovalRedirectBlocked({
          action: "approve_and_hold",
          workspaceId: "w",
          detail: "would route to /approval-queue",
        }),
      name: "approval_redirect_blocked",
    },
    {
      emit: () =>
        emitApprovalScheduleMutationBlocked({
          action: "approve_and_hold",
          workspaceId: "w",
          failureReason: "scheduled_at mutated",
        }),
      name: "approval_schedule_mutation_blocked",
    },
  ])("failure-class events set mutationBlocked=true", ({ emit, name }) => {
    withSink((cap) => {
      emit();
      expect(cap[0].name).toBe(name);
      expect(cap[0].payload.mutationBlocked).toBe(true);
    });
  });

  it("schedule_preserved records identical before+after timestamps", () => {
    withSink((cap) => {
      emitApprovalSchedulePreserved({
        action: "approve_and_hold",
        workspaceId: "w",
        planItemId: "i1",
        beforeScheduledAt: "2026-05-20T20:01:00.000Z",
        afterScheduledAt: "2026-05-20T20:01:00.000Z",
      });
      expect(cap[0].name).toBe("approval_schedule_preserved");
      expect(cap[0].payload.beforeScheduledAt).toBe(
        cap[0].payload.afterScheduledAt,
      );
    });
  });
});

describe("approval-events payload safety", () => {
  it("never leaks body / title / token fields, even when supplied", () => {
    withSink((cap) => {
      emitApprovalTransitionFailed({
        action: "approve_and_hold",
        workspaceId: "w",
        failureReason: "x",
      });
      const p = cap[0].payload;
      expect(p).not.toHaveProperty("body");
      expect(p).not.toHaveProperty("title");
      expect(p).not.toHaveProperty("token");
      expect(p).not.toHaveProperty("authorization");
      expect(p).not.toHaveProperty("email");
    });
  });

  it("always includes a UTC ISO `at` timestamp", () => {
    withSink((cap) => {
      emitApprovalTransitionStarted({
        action: "approve_and_hold",
        workspaceId: "w",
      });
      expect(cap[0].payload.at).toMatch(/T.*Z$/);
    });
  });
});
