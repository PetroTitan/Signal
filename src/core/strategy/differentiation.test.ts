import { describe, expect, it } from "vitest";
import { NEAR_SYNCHRONOUS_MINUTES, analyzeDifferentiation, type DifferentiationInput } from "./differentiation";

/** The real 2026-08-15 pair, verbatim. */
const X_BODY = "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility. CV builder. Invoice maker. Card scanner. No brand needed, no launch needed, no trend to catch. People search for the function, find the app, install it.";
const BSKY_BODY = `${X_BODY} Same demand this year as five years ago.`;
const TELEGRAM_BODY = "Privacy-first analytics does not mean operating blind.\n\nIt means collecting with restraint, keeping useful context, and avoiding measurement that creates more risk than value.";
const X_PRIVACY = "Privacy-first analytics is not blind analytics.\n\nIt means collecting with restraint, keeping useful context, and avoiding measurement that creates more risk than value.";

function post(over: Partial<DifferentiationInput> & { id: string; platform: string; body: string }): DifferentiationInput {
  return { publishedAt: "2026-08-15T14:05:00Z", title: null, linkUrl: null, ...over };
}

describe("the real historical pair", () => {
  const report = analyzeDifferentiation([
    post({ id: "x1", platform: "x", body: X_BODY, publishedAt: "2026-08-15T14:05:29Z" }),
    post({ id: "b1", platform: "bluesky", body: BSKY_BODY, publishedAt: "2026-08-15T14:25:20Z" }),
  ]);

  it("is detected with its real numbers", () => {
    expect(report.similarPairs).toHaveLength(1);
    expect(report.similarPairs[0].messagePercent).toBeGreaterThan(70);
    expect(report.similarPairs[0].minutesApart).toBe(20);
  });

  it("says what is the same and what differs", () => {
    const pair = report.similarPairs[0];
    expect(pair.same).toContain("opening line");
    expect(pair.same).toContain("core wording");
    expect(pair.different.length).toBeGreaterThan(0);
  });

  it("suggests a platform-native treatment without demanding one", () => {
    const pair = report.similarPairs[0];
    expect(pair.suggestion).toContain("Consider");
    expect(pair.suggestion?.toLowerCase()).not.toMatch(/must|cannot|blocked|not allowed/);
  });

  it("counts near-synchronous publishing", () => {
    expect(report.nearSynchronousPairs).toBe(1);
    expect(NEAR_SYNCHRONOUS_MINUTES).toBe(30);
  });
});

describe("extended beyond X and Bluesky", () => {
  it("compares Telegram too — the corpus reuses messages there as well", () => {
    const report = analyzeDifferentiation([
      post({ id: "x1", platform: "x", body: X_PRIVACY }),
      post({ id: "t1", platform: "telegram", body: TELEGRAM_BODY, publishedAt: "2026-08-15T14:30:00Z" }),
    ]);
    expect(report.platformsCompared).toEqual(["telegram", "x"]);
    expect(report.similarPairs.length).toBeGreaterThan(0);
    expect(report.similarPairs[0].platforms).toContain("telegram");
  });

  it("never compares two posts on the same platform as cross-platform", () => {
    const report = analyzeDifferentiation([
      post({ id: "x1", platform: "x", body: X_BODY }),
      post({ id: "x2", platform: "x", body: BSKY_BODY }),
    ]);
    expect(report.similarPairs).toHaveLength(0);
  });
});

describe("NOTHING here blocks", () => {
  it("exposes no blocking verdict on any pair, even at 100% identical", () => {
    const report = analyzeDifferentiation([
      post({ id: "x1", platform: "x", body: X_BODY }),
      post({ id: "b1", platform: "bluesky", body: X_BODY, publishedAt: "2026-08-15T14:06:00Z" }),
    ]);
    const pair = report.similarPairs[0];
    expect(pair.exactDuplicate).toBe(true);
    expect(pair).not.toHaveProperty("blocked");
    expect(pair).not.toHaveProperty("allowed");
    expect(pair).not.toHaveProperty("severity");
    expect(JSON.stringify(report).toLowerCase()).not.toContain("cannot publish");
  });
});

describe("empty and degenerate input", () => {
  it("ignores empty bodies rather than calling them identical", () => {
    const report = analyzeDifferentiation([
      post({ id: "x1", platform: "x", body: "" }),
      post({ id: "b1", platform: "bluesky", body: "" }),
    ]);
    expect(report.similarPairs).toHaveLength(0);
  });

  it("says so when only one platform has posts", () => {
    const report = analyzeDifferentiation([post({ id: "x1", platform: "x", body: X_BODY })]);
    expect(report.summary).toContain("only one platform".replace("only one", "Only one"));
  });

  it("handles an empty corpus", () => {
    const report = analyzeDifferentiation([]);
    expect(report.similarPairs).toEqual([]);
    expect(report.observations).toEqual([]);
  });
});

describe("observations are countable", () => {
  it("contrasts cross-platform with within-platform similarity", () => {
    const report = analyzeDifferentiation([
      post({ id: "x1", platform: "x", body: X_BODY }),
      post({ id: "x2", platform: "x", body: X_PRIVACY, publishedAt: "2026-08-14T10:00:00Z" }),
      post({ id: "b1", platform: "bluesky", body: BSKY_BODY, publishedAt: "2026-08-15T14:25:00Z" }),
    ]);
    const text = report.observations.map((o) => o.statement).join(" ");
    expect(text).toContain("most similar pair on the SAME platform");
    for (const o of report.observations) expect(o.category).toBe("observation");
  });
});
