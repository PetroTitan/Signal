import { describe, expect, it } from "vitest";
import {
  NEAR_SYNCHRONOUS_MINUTES,
  REPETITION_THRESHOLDS,
  analyzeRepetition,
  closingCta,
  hostOf,
  openingHook,
  paragraphShape,
  rhythmSimilarity,
  type RepetitionPost,
} from "./repetition";
import {
  CROSS_PLATFORM_WARN_THRESHOLD,
  asPercent,
  messageSimilarity,
  verbatimSimilarity,
} from "./similarity";
import { containsCausalClaim } from "./statistics";

/**
 * THE KNOWN HISTORICAL CASE.
 *
 * Verbatim bodies of the real 2026-08-15 pair, published 20 minutes
 * apart. This is the pair the Phase 0 audit measured at 83% word-bigram
 * similarity, and it is the regression fixture for negative control 5:
 * if the cross-platform check is weakened, this stops being detected.
 */
const REAL_X_POST =
  "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility. " +
  "CV builder. Invoice maker. Card scanner. No brand needed, no launch needed, no trend " +
  "to catch. People search for the function, find the app, install it.";

const REAL_BLUESKY_POST =
  "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility. " +
  "CV builder. Invoice maker. Card scanner. No brand needed, no launch needed, no trend " +
  "to catch. People search for the function, find the app, install it. Same demand this " +
  "year as five years ago.";

/** Two real posts from the same platform, weeks apart — the contrast case. */
const REAL_X_OTHER =
  "Analytics is not decoration.\n\nWithout it, you cannot read the situation, judge " +
  "product value, or know whether a workflow is improving.";

const HISTORICAL_PAIR: RepetitionPost[] = [
  { id: "x-aug15", platform: "x", publishedAt: "2026-08-15T14:05:29Z", body: REAL_X_POST },
  { id: "bsky-aug15", platform: "bluesky", publishedAt: "2026-08-15T14:25:20Z", body: REAL_BLUESKY_POST },
];

describe("the known historical case is detected", () => {
  // NEGATIVE CONTROL 5: disabling or loosening the cross-platform check
  // must make this fail.
  it("flags the real 2026-08-15 X↔Bluesky pair", () => {
    const report = analyzeRepetition(HISTORICAL_PAIR);
    const finding = report.findings.find((f) => f.kind === "cross_platform_copy");
    expect(finding, "the historical cross-platform pair must be detected").toBeTruthy();
    expect(finding!.severity).toBe("high");
    expect(finding!.platforms).toEqual(["bluesky", "x"]);
  });

  it("measures it well above the reporting threshold", () => {
    const similarity = messageSimilarity(REAL_X_POST, REAL_BLUESKY_POST);
    expect(similarity).toBeGreaterThan(CROSS_PLATFORM_WARN_THRESHOLD);
    // The audit measured ~83% on this pair.
    expect(asPercent(similarity)).toBeGreaterThan(70);
  });

  it("reports the numbers, not an adjective", () => {
    const finding = analyzeRepetition(HISTORICAL_PAIR).findings.find(
      (f) => f.kind === "cross_platform_copy",
    )!;
    expect(finding.evidence).toMatch(/Cross-platform similarity \d+(\.\d+)?%/);
    expect(finding.evidence).toContain("20 minutes apart");
    expect(finding.detail.minutesApart).toBe(20);
    expect(finding.detail.synchronous).toBe(true);
  });

  it("separates the cross-platform case from same-platform noise", () => {
    const report = analyzeRepetition([
      ...HISTORICAL_PAIR,
      { id: "x-jun", platform: "x", publishedAt: "2026-06-13T16:10:00Z", body: REAL_X_OTHER },
    ]);
    // The measured contrast: cross-platform reaches 83%, within-platform
    // never exceeded 7.8% across the whole real corpus.
    expect(report.maxCrossPlatformPercent!).toBeGreaterThan(70);
    expect(report.maxWithinPlatformPercent!).toBeLessThan(
      REPETITION_THRESHOLDS.crossPlatformWarn * 100,
    );
  });
});

describe("cross-platform detection", () => {
  function pair(bodyA: string, bodyB: string, minutesApart = 5): RepetitionPost[] {
    const base = Date.parse("2026-06-13T16:00:00Z");
    return [
      { id: "a", platform: "x", publishedAt: new Date(base).toISOString(), body: bodyA },
      {
        id: "b",
        platform: "bluesky",
        publishedAt: new Date(base + minutesApart * 60000).toISOString(),
        body: bodyB,
      },
    ];
  }

  it("catches a reworded message that 5-token shingles would miss", () => {
    // This is why the module uses bigrams as well: the rephrasings at
    // 45.7% / 36.4% bigram similarity share almost no five-word runs.
    const a = "Privacy-first analytics is not blind analytics. It means collecting with restraint, keeping useful context, and avoiding measurement that creates more risk than value.";
    const b = "Privacy-first analytics does not mean operating blind. It means collecting with restraint, preserving useful context, and avoiding measurement that creates more risk than value.";
    const report = analyzeRepetition(pair(a, b));
    expect(report.findings.some((f) => f.kind === "cross_platform_copy")).toBe(true);
    expect(messageSimilarity(a, b)).toBeGreaterThan(verbatimSimilarity(a, b) * 0.9);
  });

  it("does not flag two genuinely different messages", () => {
    const report = analyzeRepetition(
      pair(
        "Evidence needs a loop. Analytics shows the situation, a decision changes something, review shows whether it worked.",
        "Switzerland is not in EU roaming. Most people learn that from the bill.",
      ),
    );
    expect(report.findings.some((f) => f.kind === "cross_platform_copy")).toBe(false);
  });

  it("marks an exact duplicate as exact, not merely similar", () => {
    const body = "Same words, both platforms.";
    const report = analyzeRepetition(pair(body, `${body.toUpperCase()}!!!`));
    const finding = report.findings.find((f) => f.kind === "exact_duplicate");
    expect(finding).toBeTruthy();
    expect(finding!.severity).toBe("high");
  });

  it("notices near-simultaneous publishing even when the copy differs", () => {
    const report = analyzeRepetition(
      pair(
        "Evidence needs a loop, and review closes it.",
        "Switzerland is not in EU roaming; the bill teaches you.",
        3,
      ),
    );
    const sync = report.findings.find((f) => f.kind === "synchronous_publication");
    expect(sync).toBeTruthy();
    expect(sync!.severity).toBe("info");
    expect(sync!.evidence).toContain("different copy");
  });

  it("does not raise a synchrony finding for posts far apart", () => {
    const report = analyzeRepetition(
      pair("Something entirely unrelated about roaming.", "A different thought about analytics.", NEAR_SYNCHRONOUS_MINUTES + 60),
    );
    expect(report.findings.some((f) => f.kind === "synchronous_publication")).toBe(false);
  });
});

describe("structural signals", () => {
  it("extracts the opening hook and the closing CTA", () => {
    const body = "Analytics is not decoration.\n\nMiddle line.\n\nStart measuring today.";
    expect(openingHook(body)).toBe("Analytics is not decoration.");
    expect(closingCta(body)).toBe("Start measuring today.");
  });

  it("prefers an explicit title as the hook", () => {
    expect(openingHook("body line", "Real Title")).toBe("Real Title");
  });

  it("has no CTA for a single-line post", () => {
    expect(closingCta("Only one line.")).toBe("");
  });

  it("flags a repeated call to action", () => {
    const mk = (id: string, platform: string, opener: string): RepetitionPost => ({
      id,
      platform,
      publishedAt: "2026-06-13T16:00:00Z",
      body: `${opener}\n\nSome different middle content here entirely.\n\nTry WebmasterID today.`,
    });
    const report = analyzeRepetition([
      mk("a", "x", "First opener about analytics."),
      mk("b", "bluesky", "Completely separate thought on roaming."),
    ]);
    expect(report.findings.some((f) => f.kind === "repeated_cta")).toBe(true);
  });

  it("compares paragraph rhythm as a shape, not by strict equality", () => {
    // Same skeleton, different words — the dominant pattern in the real
    // corpus, and invisible to an equality check.
    const a = "Short opener.\n\nA somewhat longer elaboration that runs on for a while with detail.\n\nClosing line.";
    const b = "Different opener.\n\nAnother fairly long elaboration that also continues for a while here.\n\nOther closer.";
    expect(rhythmSimilarity(a, b)).toBeGreaterThan(REPETITION_THRESHOLDS.rhythm - 0.01);
    expect(paragraphShape(a)).toHaveLength(3);
  });

  it("reports a shared link destination by host", () => {
    const report = analyzeRepetition([
      { id: "a", platform: "x", publishedAt: "2026-06-13T16:00:00Z", body: "One", linkUrl: "https://www.webmasterid.com/a" },
      { id: "b", platform: "bluesky", publishedAt: "2026-06-13T16:05:00Z", body: "Two", linkUrl: "https://webmasterid.com/b" },
    ]);
    const finding = report.findings.find((f) => f.kind === "repeated_link");
    expect(finding).toBeTruthy();
    expect(finding!.detail.host).toBe("webmasterid.com");
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("the report never overclaims", () => {
  const report = analyzeRepetition([
    ...HISTORICAL_PAIR,
    { id: "x-jun", platform: "x", publishedAt: "2026-06-13T16:10:00Z", body: REAL_X_OTHER },
  ]);

  it("emits no causal or provider-classification claim anywhere", () => {
    // "Provider classified this as spam" is not something any provider
    // exposes, so asserting it would be inventing evidence.
    const strings = [report.summary, ...report.findings.map((f) => f.evidence)];
    for (const text of strings) {
      expect(containsCausalClaim(text), text).toBe(false);
      // Word boundaries matter: "Both posts open the same way" contains
      // the substring "bot" and is a perfectly honest sentence.
      expect(text).not.toMatch(/\bspam\b/i);
      expect(text).not.toMatch(/\bbots?\b/i);
      expect(text).not.toMatch(/\bautomation footprint\b/i);
    }
  });

  it("summarises with numbers rather than a judgement", () => {
    expect(report.summary).toMatch(/\d/);
    expect(report.summary.toLowerCase()).not.toMatch(/bad|awful|terrible|spammy/);
  });

  it("says so plainly when nothing is above threshold", () => {
    const clean = analyzeRepetition([
      { id: "a", platform: "x", publishedAt: "2026-06-01T10:00:00Z", body: "Roaming charges surprise people." },
      { id: "b", platform: "bluesky", publishedAt: "2026-06-05T18:00:00Z", body: "Instrumentation starts before the event name." },
    ]);
    expect(clean.summary).toContain("No cross-platform message reuse");
  });
});

describe("determinism and bounds", () => {
  it("produces identical output for the same input regardless of order", () => {
    const a = analyzeRepetition(HISTORICAL_PAIR);
    const b = analyzeRepetition([...HISTORICAL_PAIR].reverse());
    expect(JSON.stringify(a.findings)).toBe(JSON.stringify(b.findings));
  });

  it("handles a single post and an empty corpus without throwing", () => {
    expect(analyzeRepetition([]).summary).toContain("Not enough posts");
    expect(analyzeRepetition([HISTORICAL_PAIR[0]]).pairsCompared).toBe(0);
  });

  it("compares every pair exactly once", () => {
    const posts = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      platform: i % 2 === 0 ? "x" : "bluesky",
      publishedAt: new Date(Date.parse("2026-06-01T00:00:00Z") + i * 86400000).toISOString(),
      body: `Unique body number ${i} with distinct wording throughout the whole thing.`,
    }));
    expect(analyzeRepetition(posts).pairsCompared).toBe(15); // 6 choose 2
  });

  it("orders findings by severity", () => {
    const report = analyzeRepetition(HISTORICAL_PAIR);
    const ranks = report.findings.map((f) =>
      f.severity === "high" ? 0 : f.severity === "warn" ? 1 : 2,
    );
    expect([...ranks].sort((x, y) => x - y)).toEqual(ranks);
  });
});
