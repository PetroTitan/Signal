import { describe, expect, it } from "vitest";
import {
  assembleResult,
  formatPublishDuration,
  type ResultContext,
  type ResultSourceRow,
} from "./results-view";

function row(over: Partial<ResultSourceRow> = {}): ResultSourceRow {
  return {
    id: "ph-1",
    executionItemId: "ei-1",
    platform: "bluesky",
    subreddit: null,
    outcome: "published",
    permalink: "https://bsky.app/p/1",
    providerPostId: "1",
    startedAtIso: "2026-06-13T12:00:00.000Z",
    finishedAtIso: "2026-06-13T12:00:01.200Z",
    mode: "api",
    reasonCode: "ok",
    ...over,
  };
}

function ctx(over: Partial<ResultContext> = {}): ResultContext {
  return {
    title: "Launch note",
    identityLabel: "@founder.bsky.social",
    operatorNotes: null,
    attemptCount: 1,
    logs: [],
    ...over,
  };
}

describe("assembleResult", () => {
  it("assembles a published result from source-of-truth fields", () => {
    const r = assembleResult({ row: row(), context: ctx() });
    expect(r.platform).toBe("bluesky");
    expect(r.permalink).toBe("https://bsky.app/p/1");
    expect(r.identityLabel).toBe("@founder.bsky.social");
    expect(r.detailHref).toBe("/execution/items/ei-1");
    expect(r.publishedAtIso).toBe("2026-06-13T12:00:01.200Z");
  });

  it("computes publish duration from started/finished", () => {
    expect(assembleResult({ row: row(), context: ctx() }).publishDurationMs).toBe(1200);
  });

  it("null duration when timestamps are inverted/invalid", () => {
    const r = assembleResult({
      row: row({ startedAtIso: "2026-06-13T12:00:05Z", finishedAtIso: "2026-06-13T12:00:00Z" }),
      context: ctx(),
    });
    expect(r.publishDurationMs).toBeNull();
  });

  it("detects retries from attempt_count and retry logs", () => {
    const retried = assembleResult({
      row: row(),
      context: ctx({
        attemptCount: 2,
        logs: [
          { eventType: "item.failed", severity: "error", message: "x", createdAtIso: "2026-06-13T11:55:00Z" },
          { eventType: "item.completed", severity: "info", message: "ok", createdAtIso: "2026-06-13T12:00:01Z" },
        ],
      }),
    });
    expect(retried.retried).toBe(true);
    expect(retried.retryEvents).toHaveLength(1);
  });

  it("first-try publish is not flagged retried", () => {
    expect(assembleResult({ row: row(), context: ctx({ attemptCount: 1, logs: [] }) }).retried).toBe(false);
  });

  it("metrics default to not_connected (never faked)", () => {
    const r = assembleResult({ row: row(), context: ctx() });
    expect(r.metricsStatus).toBe("not_connected");
    expect(r.metrics).toBeNull();
  });

  it("attaches verified provider metrics when supplied (extension point)", () => {
    const r = assembleResult({
      row: row(),
      context: ctx(),
      metrics: { likes: 5, source: "x_api_v2", fetchedAtIso: "2026-06-13T13:00:00Z" },
    });
    expect(r.metricsStatus).toBe("connected");
    expect(r.metrics?.likes).toBe(5);
  });

  it("carries operator notes through", () => {
    expect(
      assembleResult({ row: row(), context: ctx({ operatorNotes: "promoted in newsletter" }) })
        .operatorNotes,
    ).toBe("promoted in newsletter");
  });
});

describe("formatPublishDuration", () => {
  it("formats ms / seconds / dash", () => {
    expect(formatPublishDuration(830)).toBe("830ms");
    expect(formatPublishDuration(1200)).toBe("1.2s");
    expect(formatPublishDuration(null)).toBe("—");
  });
});
