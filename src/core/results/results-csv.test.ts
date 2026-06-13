import { describe, expect, it } from "vitest";
import {
  csvCell,
  metricsHistoryCsv,
  platformPerformanceCsv,
  topPostsCsv,
} from "./results-csv";

describe("csvCell", () => {
  it("quotes cells with commas, quotes, or newlines", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });
});

describe("topPostsCsv", () => {
  it("emits a header + one row per post, escaping titles", () => {
    const csv = topPostsCsv([
      {
        publishHistoryId: "p1",
        title: "Hello, world",
        platform: "bluesky",
        permalink: "https://x",
        engagement: 42,
        publishedAtIso: "2026-06-01T00:00:00Z",
      },
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("published_at,platform,title,engagement,permalink");
    expect(lines[1]).toContain('"Hello, world"');
    expect(lines[1]).toContain("42");
  });

  it("header-only for empty input (never a blank file)", () => {
    expect(topPostsCsv([]).trim()).toBe("published_at,platform,title,engagement,permalink");
  });
});

describe("platformPerformanceCsv", () => {
  it("rounds avg engagement and lists each platform", () => {
    const csv = platformPerformanceCsv([
      { platform: "bluesky", posts: 3, totalEngagement: 10, avgEngagement: 3.3333 },
    ]);
    expect(csv).toContain("bluesky,3,10,3.33");
  });
});

describe("metricsHistoryCsv", () => {
  it("emits verified metric columns only (blanks where absent)", () => {
    const csv = metricsHistoryCsv([
      {
        publishHistoryId: "p1",
        platform: "reddit",
        fetchedAt: "2026-06-01T00:00:00Z",
        status: "connected",
        metrics: { score: 12, comments: 4 },
      },
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("score,reactions,comments,views");
    // reddit row → score 12, comments 4, no likes/views
    expect(lines[1]).toContain("reddit");
    expect(lines[1]).toContain("12");
    expect(lines[1]).toContain("4");
  });
});
