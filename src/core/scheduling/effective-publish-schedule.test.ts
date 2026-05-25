import { describe, expect, it } from "vitest";
import {
  ACTIVE_EXECUTION_STATUSES,
  describeEffectiveSource,
  getEffectivePublishSchedule,
} from "./effective-publish-schedule";

/**
 * Tests pin the "which timestamp is the source of truth?" decision
 * table so the card / page / MCP consumers can't accidentally
 * regress to reading weekly_plan_items.scheduled_at when an active
 * execution_item exists.
 */

const PI_ISO = "2026-05-25T21:33:00.000Z";
const EI_ISO = "2026-05-25T21:33:00.000Z";
const EI_ISO_OTHER = "2026-05-26T06:53:00.000Z";

describe("ACTIVE_EXECUTION_STATUSES — canonical set", () => {
  it("is exactly { pending_authorization, authorized, scheduled }", () => {
    expect(ACTIVE_EXECUTION_STATUSES.size).toBe(3);
    expect(ACTIVE_EXECUTION_STATUSES.has("pending_authorization")).toBe(true);
    expect(ACTIVE_EXECUTION_STATUSES.has("authorized")).toBe(true);
    expect(ACTIVE_EXECUTION_STATUSES.has("scheduled")).toBe(true);
  });

  it("excludes terminal / runner / retry statuses", () => {
    for (const s of [
      "completed",
      "failed",
      "blocked",
      "cancelled",
      "skipped",
      "backlogged",
      "running",
      "ready",
      "ready_for_manual_publish",
      "paused",
    ]) {
      expect(ACTIVE_EXECUTION_STATUSES.has(s)).toBe(false);
    }
  });
});

describe("getEffectivePublishSchedule — no execution_item", () => {
  it("editorial only → source=weekly_plan_item", () => {
    const r = getEffectivePublishSchedule({ scheduledAt: PI_ISO });
    expect(r.editorialScheduledAt).toBe(PI_ISO);
    expect(r.executionScheduledAt).toBe(null);
    expect(r.effectiveScheduledAt).toBe(PI_ISO);
    expect(r.source).toBe("weekly_plan_item");
    expect(r.isDiverged).toBe(false);
    expect(r.divergenceMs).toBe(null);
  });

  it("no editorial, no exec → source=none, effective=null", () => {
    const r = getEffectivePublishSchedule({ scheduledAt: null });
    expect(r.source).toBe("none");
    expect(r.effectiveScheduledAt).toBe(null);
    expect(r.isDiverged).toBe(false);
  });

  it("explicit null exec is equivalent to absent", () => {
    const r = getEffectivePublishSchedule({ scheduledAt: PI_ISO }, null);
    expect(r.source).toBe("weekly_plan_item");
    expect(r.effectiveScheduledAt).toBe(PI_ISO);
  });
});

describe("getEffectivePublishSchedule — active execution_item", () => {
  for (const status of ["pending_authorization", "authorized", "scheduled"]) {
    it(`status=${status} → source=execution_item`, () => {
      const r = getEffectivePublishSchedule(
        { scheduledAt: PI_ISO },
        { status, scheduledAt: EI_ISO },
      );
      expect(r.source).toBe("execution_item");
      expect(r.effectiveScheduledAt).toBe(EI_ISO);
      expect(r.executionScheduledAt).toBe(EI_ISO);
      expect(r.editorialScheduledAt).toBe(PI_ISO);
    });
  }

  it("active exec with null exec time falls back to editorial", () => {
    // Edge case: exec_item exists with NULL scheduled_at (shouldn't
    // happen in practice but the helper must degrade safely).
    const r = getEffectivePublishSchedule(
      { scheduledAt: PI_ISO },
      { status: "scheduled", scheduledAt: null },
    );
    expect(r.source).toBe("weekly_plan_item");
    expect(r.effectiveScheduledAt).toBe(PI_ISO);
  });
});

describe("getEffectivePublishSchedule — terminal / blocking execution statuses", () => {
  for (const status of [
    "completed",
    "failed",
    "blocked",
    "cancelled",
    "skipped",
    "backlogged",
    "running",
    "ready",
    "ready_for_manual_publish",
    "paused",
  ]) {
    it(`status=${status} → fall back to editorial`, () => {
      const r = getEffectivePublishSchedule(
        { scheduledAt: PI_ISO },
        { status, scheduledAt: EI_ISO_OTHER },
      );
      expect(r.source).toBe("weekly_plan_item");
      expect(r.effectiveScheduledAt).toBe(PI_ISO);
      // Even though we don't use the exec time as effective, we
      // expose it on the result so callers can show a "history" row.
      // For non-active statuses we expose null to avoid suggesting
      // the operator should resync against a terminal row.
      expect(r.executionScheduledAt).toBe(null);
    });
  }
});

describe("getEffectivePublishSchedule — divergence detection", () => {
  it("equal timestamps → isDiverged=false, divergenceMs=0", () => {
    const r = getEffectivePublishSchedule(
      { scheduledAt: PI_ISO },
      { status: "scheduled", scheduledAt: PI_ISO },
    );
    expect(r.isDiverged).toBe(false);
    expect(r.divergenceMs).toBe(0);
  });

  it("sub-second drift is tolerated (precision rounding)", () => {
    const r = getEffectivePublishSchedule(
      { scheduledAt: "2026-05-25T21:33:00.000Z" },
      { status: "scheduled", scheduledAt: "2026-05-25T21:33:00.999Z" },
    );
    expect(r.isDiverged).toBe(false);
    expect(r.divergenceMs).toBe(999);
  });

  it("multi-second divergence → isDiverged=true", () => {
    const r = getEffectivePublishSchedule(
      { scheduledAt: "2026-05-25T19:44:00.000Z" },
      { status: "scheduled", scheduledAt: "2026-05-26T06:53:00.000Z" },
    );
    expect(r.isDiverged).toBe(true);
    expect(r.divergenceMs).toBeGreaterThan(0);
  });

  it("divergence is null when one side is missing", () => {
    expect(
      getEffectivePublishSchedule(
        { scheduledAt: null },
        { status: "scheduled", scheduledAt: PI_ISO },
      ).divergenceMs,
    ).toBe(null);
    expect(
      getEffectivePublishSchedule(
        { scheduledAt: PI_ISO },
        { status: "scheduled", scheduledAt: null },
      ).divergenceMs,
    ).toBe(null);
  });
});

describe("describeEffectiveSource", () => {
  it("execution_item → 'Publish trigger: execution item'", () => {
    expect(
      describeEffectiveSource({
        source: "execution_item",
        effectiveScheduledAt: PI_ISO,
      }),
    ).toBe("Publish trigger: execution item");
  });

  it("weekly_plan_item → 'Planning time only'", () => {
    expect(
      describeEffectiveSource({
        source: "weekly_plan_item",
        effectiveScheduledAt: PI_ISO,
      }),
    ).toBe("Planning time only");
  });

  it("none → 'No schedule'", () => {
    expect(
      describeEffectiveSource({
        source: "none",
        effectiveScheduledAt: null,
      }),
    ).toBe("No schedule");
  });
});
