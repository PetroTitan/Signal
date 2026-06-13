import { describe, expect, it, vi } from "vitest";
import {
  claimExecutionItem,
  isStaleClaim,
  STALE_CLAIM_MINUTES,
} from "./execution-claim";

/**
 * Fake Supabase query builder that records the guarded UPDATE and
 * returns a configurable affected-row set. Mirrors the real
 * `.from().update().eq().eq().eq().select()` chain shape.
 */
function fakeClient(opts: { affectedRows: number; error?: string }) {
  const calls: { update?: unknown; eqs: Array<[string, unknown]> } = { eqs: [] };
  const builder = {
    update(payload: unknown) {
      calls.update = payload;
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.eqs.push([col, val]);
      return builder;
    },
    select() {
      return Promise.resolve(
        opts.error
          ? { data: null, error: { message: opts.error } }
          : {
              data: Array.from({ length: opts.affectedRows }, (_, i) => ({ id: `row-${i}` })),
              error: null,
            },
      );
    },
  };
  return {
    calls,
    client: {
      from() {
        return builder;
      },
    } as never,
  };
}

const BASE = {
  workspaceId: "ws-1",
  itemId: "ei-1",
  currentMetadata: { plan_item_id: "pi-1", contract_mode: "free" },
  schedulerRunId: "run-abc",
  nowIso: "2026-06-13T12:00:00.000Z",
};

describe("claimExecutionItem", () => {
  it("claims when the row is still scheduled (1 affected row)", async () => {
    const { client, calls } = fakeClient({ affectedRows: 1 });
    const r = await claimExecutionItem({ supabase: client, ...BASE });
    expect(r.claimed).toBe(true);
    // The atomic guard: update gated on status='scheduled' + ids.
    expect(calls.eqs).toContainEqual(["status", "scheduled"]);
    expect(calls.eqs).toContainEqual(["id", "ei-1"]);
    expect(calls.eqs).toContainEqual(["workspace_id", "ws-1"]);
    // Writes status=running + a claim record, preserving prior metadata.
    const payload = calls.update as { status: string; metadata: Record<string, unknown> };
    expect(payload.status).toBe("running");
    expect(payload.metadata.contract_mode).toBe("free");
    const claim = payload.metadata.scheduler_claim as Record<string, unknown>;
    expect(claim.scheduler_run_id).toBe("run-abc");
    expect(claim.plan_item_id).toBe("pi-1");
    expect(claim.claimed_at).toBe("2026-06-13T12:00:00.000Z");
    expect(claim.claim_source).toBe("cron_tick");
  });

  it("does NOT claim when zero rows are affected (someone else won the race)", async () => {
    const { client } = fakeClient({ affectedRows: 0 });
    const r = await claimExecutionItem({ supabase: client, ...BASE });
    expect(r.claimed).toBe(false);
    if (!r.claimed) expect(r.reason).toBe("already_claimed_or_moved");
  });

  it("reports claim_error on a DB error (caller skips, never publishes)", async () => {
    const { client } = fakeClient({ affectedRows: 0, error: "deadlock" });
    const r = await claimExecutionItem({ supabase: client, ...BASE });
    expect(r.claimed).toBe(false);
    if (!r.claimed) expect(r.reason).toBe("claim_error");
  });

  it("includes the payload fingerprint when provided", async () => {
    const { client, calls } = fakeClient({ affectedRows: 1 });
    await claimExecutionItem({ supabase: client, ...BASE, payloadFingerprint: "fp-123" });
    const payload = calls.update as { metadata: Record<string, unknown> };
    const claim = payload.metadata.scheduler_claim as Record<string, unknown>;
    expect(claim.payload_fingerprint).toBe("fp-123");
  });

  it("simulated two ticks: only the first claim succeeds", async () => {
    // First tick: row still scheduled → 1 row.
    const first = fakeClient({ affectedRows: 1 });
    const r1 = await claimExecutionItem({ supabase: first.client, ...BASE, schedulerRunId: "run-1" });
    // Second tick on the now-running row → guard matches 0 rows.
    const second = fakeClient({ affectedRows: 0 });
    const r2 = await claimExecutionItem({ supabase: second.client, ...BASE, schedulerRunId: "run-2" });
    expect(r1.claimed).toBe(true);
    expect(r2.claimed).toBe(false);
  });
});

describe("isStaleClaim", () => {
  const now = new Date("2026-06-13T12:30:00.000Z");
  it("flags a claim older than the threshold", () => {
    expect(isStaleClaim("2026-06-13T12:00:00.000Z", now)).toBe(true); // 30m old
  });
  it("does not flag a fresh claim", () => {
    expect(isStaleClaim("2026-06-13T12:25:00.000Z", now)).toBe(false); // 5m old
  });
  it("treats a missing/invalid claim timestamp as stale (surface it)", () => {
    expect(isStaleClaim(null, now)).toBe(true);
    expect(isStaleClaim("not-a-date", now)).toBe(true);
  });
  it("uses a sane default threshold", () => {
    expect(STALE_CLAIM_MINUTES).toBeGreaterThanOrEqual(10);
  });
});
