import { describe, expect, it } from "vitest";
import {
  SweepReportBuilder,
  diagnose,
  redactSecrets,
  sweepLogLine,
  type SweepReport,
} from "./sweep-report";

function builder(over: Partial<ConstructorParameters<typeof SweepReportBuilder>[0]> = {}) {
  return new SweepReportBuilder({
    runId: "run-1",
    startedAt: "2026-08-19T06:00:00.000Z",
    seedWindowDays: 14,
    staleLimit: 100,
    seedLimit: 50,
    verifiedPlatforms: ["bluesky", "devto", "reddit"],
    ...over,
  });
}

describe("redactSecrets", () => {
  it("strips bearer and basic authorization values", () => {
    expect(redactSecrets("failed: Authorization: Bearer abc123def456ghi")).not.toContain(
      "abc123def456ghi",
    );
    expect(redactSecrets("Basic dXNlcjpwYXNzd29yZA==")).toContain("[redacted]");
  });

  it("strips Signal operator tokens and JWTs", () => {
    expect(redactSecrets("token sigt_AAAABBBBCCCC used")).toBe(
      "token sigt_[redacted] used",
    );
    expect(
      redactSecrets("key eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"),
    ).toContain("[redacted-jwt]");
  });

  it("strips credential-shaped query parameters", () => {
    const out = redactSecrets("GET /x?access_token=SECRETVALUE&post=1 failed");
    expect(out).not.toContain("SECRETVALUE");
    expect(out).toContain("access_token=[redacted]");
  });

  it("bounds the field so an HTML error page cannot fill the record", () => {
    expect(redactSecrets("x".repeat(5000)).length).toBeLessThanOrEqual(300);
  });

  it("handles Errors, null and non-strings without throwing", () => {
    expect(redactSecrets(new Error("boom"))).toBe("boom");
    expect(redactSecrets(null)).toBe("");
    expect(redactSecrets(42)).toBe("42");
  });
});

describe("diagnose — the zero-row explanations", () => {
  it("names a total loader failure rather than reporting an empty backlog", () => {
    const b = builder();
    b.recordLoader("stale", { ok: false, error: new Error("permission denied") });
    b.recordLoader("unmeasured", { ok: false, error: new Error("permission denied") });
    b.recordCandidates([]);
    const r = b.complete("2026-08-19T06:00:01.000Z");
    expect(r.diagnosis).toContain("BOTH candidate loaders failed");
    expect(r.diagnosis).toContain("permission denied");
    expect(r.diagnosis).toContain("not an empty backlog");
  });

  it("explains an empty run by naming the enrolment window and the backfill", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([]);
    const r = b.complete("2026-08-19T06:00:01.000Z");
    // This is the exact production situation: publications exist, but all
    // of them are older than the window, so the sweep sees nothing.
    expect(r.diagnosis).toContain("14-day enrolment window");
    expect(r.diagnosis).toContain("backfill");
  });

  it("flags a partial loader failure even when the other loader succeeded", () => {
    const b = builder();
    b.recordLoader("stale", { ok: false, error: "boom" });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([]);
    expect(b.complete("2026-08-19T06:00:01.000Z").diagnosis).toContain(
      "may be incomplete",
    );
  });

  it("distinguishes candidates-all-skipped from no-candidates", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 1 });
    b.recordCandidates([{ workspaceId: "w1", platform: "x" }]);
    b.recordSkip({
      workspaceId: "w1",
      publishHistoryId: "ph1",
      platform: "x",
      reason: "no_provider_identifier",
    });
    const r = b.complete("2026-08-19T06:00:01.000Z");
    expect(r.diagnosis).toContain("none reached a provider");
    expect(r.diagnosis).toContain("no_provider_identifier");
  });

  it("names the failing provider when every read came back empty", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 1 });
    b.recordCandidates([{ workspaceId: "w1", platform: "bluesky" }]);
    b.recordRead({
      workspaceId: "w1",
      publishHistoryId: "ph1",
      platform: "bluesky",
      outcome: "failed",
      reason: "getPosts 500",
    });
    const r = b.complete("2026-08-19T06:00:01.000Z");
    expect(r.diagnosis).toContain("none returned");
    expect(r.diagnosis).toContain("bluesky");
  });

  it("reports a healthy run with the success ratio", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 2 });
    b.recordCandidates([
      { workspaceId: "w1", platform: "bluesky" },
      { workspaceId: "w1", platform: "x" },
    ]);
    b.recordRead({ workspaceId: "w1", publishHistoryId: "a", platform: "bluesky", outcome: "connected" });
    b.recordRead({ workspaceId: "w1", publishHistoryId: "b", platform: "x", outcome: "connected" });
    const r = b.complete("2026-08-19T06:00:02.000Z");
    expect(r.diagnosis).toContain("2 of 2");
    expect(r.succeeded).toBe(2);
    expect(r.durationMs).toBe(2000);
  });
});

describe("SweepReportBuilder tallies", () => {
  it("counts a rate limit separately from a plain unavailable", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 2 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([
      { workspaceId: "w1", platform: "x" },
      { workspaceId: "w1", platform: "x" },
    ]);
    b.recordRead({ workspaceId: "w1", publishHistoryId: "a", platform: "x", outcome: "rate_limited" });
    b.recordRead({ workspaceId: "w1", publishHistoryId: "b", platform: "x", outcome: "unavailable" });
    const r = b.complete("2026-08-19T06:00:01.000Z");
    expect(r.rateLimited).toBe(1);
    expect(r.unavailable).toBe(1);
    expect(r.byPlatform.x.rateLimited).toBe(1);
    expect(r.byPlatform.x.unavailable).toBe(1);
    // A throttled read is retryable, so it must never count as success.
    expect(r.succeeded).toBe(0);
  });

  it("answers every question the operator contract requires", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 1 });
    b.recordLoader("unmeasured", { ok: true, count: 1 });
    b.recordCandidates([
      { workspaceId: "w1", platform: "bluesky" },
      { workspaceId: "w2", platform: "reddit" },
    ]);
    b.recordRead({ workspaceId: "w1", publishHistoryId: "a", platform: "bluesky", outcome: "connected" });
    b.recordRead({ workspaceId: "w2", publishHistoryId: "b", platform: "reddit", outcome: "failed", reason: "500" });
    const r: SweepReport = b.complete("2026-08-19T06:00:05.000Z");

    expect(r.phase).toBe("completed");        // did it start and finish
    expect(Object.keys(r.byWorkspace).sort()).toEqual(["w1", "w2"]); // which workspaces
    expect(r.candidates).toBe(2);             // candidates found
    expect(r.enrolled).toBe(1);               // enrolled
    expect(r.attempted).toBe(2);              // reads attempted
    expect(r.succeeded).toBe(1);              // succeeded
    expect(r.skipped).toBe(0);                // skipped
    expect(r.rateLimited).toBe(0);            // rate limited
    expect(r.failed).toBe(1);                 // failed
    expect(r.failures[0].platform).toBe("reddit"); // which provider failed
  });

  it("bounds failure and skip lists so a systemic fault cannot flood the row", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([]);
    for (let i = 0; i < 200; i += 1) {
      b.recordRead({ workspaceId: "w1", publishHistoryId: `p${i}`, platform: "x", outcome: "failed" });
      b.recordSkip({ workspaceId: "w1", publishHistoryId: `s${i}`, platform: "x", reason: "no_provider_identifier" });
    }
    const r = b.complete("2026-08-19T06:00:01.000Z");
    expect(r.failures.length).toBe(50);
    expect(r.skips.length).toBe(50);
    // Counters keep the true totals even though the samples are bounded.
    expect(r.failed).toBe(200);
    expect(r.skipped).toBe(200);
  });

  it("redacts secrets that arrive through a provider error", () => {
    const b = builder();
    b.recordLoader("stale", { ok: false, error: "auth failed: Bearer sk-live-ABCDEFGH12345678" });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([]);
    const r = b.complete("2026-08-19T06:00:01.000Z");
    expect(JSON.stringify(r)).not.toContain("sk-live-ABCDEFGH12345678");
  });

  it("records a fatal throw as failed, not as an empty success", () => {
    const b = builder();
    const r = b.fail("2026-08-19T06:00:01.000Z", new Error("connection reset"));
    expect(r.phase).toBe("failed");
    expect(r.fatalError).toBe("connection reset");
    expect(r.diagnosis).toContain("threw before completing");
  });

  it("snapshot() returns a detached copy so later mutation cannot rewrite history", () => {
    const b = builder();
    const first = b.snapshot();
    b.recordRead({ workspaceId: "w1", publishHistoryId: "a", platform: "x", outcome: "connected" });
    expect(first.attempted).toBe(0);
    expect(b.snapshot().attempted).toBe(1);
  });
});

describe("sweepLogLine", () => {
  it("emits one parseable JSON line carrying the diagnosis", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([]);
    const parsed = JSON.parse(sweepLogLine(b.complete("2026-08-19T06:00:01.000Z")));
    expect(parsed.tag).toBe("metrics-sweep");
    expect(parsed.runId).toBe("run-1");
    expect(typeof parsed.diagnosis).toBe("string");
    expect(parsed.seedWindowDays).toBe(14);
  });
});

describe("diagnose is a pure function of the report", () => {
  it("produces the same sentence for the same input", () => {
    const b = builder();
    b.recordLoader("stale", { ok: true, count: 0 });
    b.recordLoader("unmeasured", { ok: true, count: 0 });
    b.recordCandidates([]);
    const r = b.complete("2026-08-19T06:00:01.000Z");
    expect(diagnose(r)).toBe(diagnose(r));
  });
});
