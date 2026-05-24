import { describe, expect, it } from "vitest";
import {
  canonicalize,
  hookSimilarity,
  jaccard,
  NEAR_DUP_THRESHOLD,
  scanForNearDuplicates,
  shingles,
  tokenize,
} from "./near-duplicate";
import type { QaRecentPost } from "./types";

describe("canonicalize / tokenize / shingles", () => {
  it("lowercases, strips URLs, and collapses punctuation", () => {
    expect(canonicalize("Visit https://x.com/y — it's great!")).toBe(
      "visit it s great",
    );
  });

  it("returns a single shingle when input is shorter than k", () => {
    const s = shingles(tokenize("short text"));
    expect(s.size).toBe(1);
  });

  it("produces overlapping 5-grams for long inputs", () => {
    const toks = tokenize("the quick brown fox jumps over the lazy dog now");
    const s = shingles(toks);
    expect(s.size).toBe(toks.length - 5 + 1);
  });
});

describe("jaccard / hookSimilarity", () => {
  it("jaccard of identical sets is 1", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });
  it("jaccard of disjoint sets is 0", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
  it("hookSimilarity of identical canonicalized strings is 1", () => {
    expect(hookSimilarity("Hello world!", "hello   world")).toBe(1);
  });
  it("hookSimilarity scales by prefix overlap", () => {
    expect(
      hookSimilarity("Most crawler logs", "Most crawler logs still treat"),
    ).toBeGreaterThan(0.5);
  });
});

describe("scanForNearDuplicates", () => {
  const baseHistory: QaRecentPost[] = [
    {
      platform: "x",
      hook: "Most crawler logs still treat AI agents as noise.",
      body: "Most crawler logs still treat AI agents as noise. A pattern in the last 30 days of bot traffic shows a measurable share of agentic requests we keep ignoring. The shape of the AI-native web has changed; the analytics stack hasn't.",
      publishedAt: "2026-05-20T10:00:00Z",
    },
    {
      platform: "hashnode",
      hook: "An architecture note on observability for non-human traffic.",
      body: "We started asking: what understood? Most analytics platforms answer the question who visited. The architecture pivot starts with a shingle-keyed dedup layer.",
      publishedAt: "2026-05-18T10:00:00Z",
    },
  ];

  it("flags an exact repost as a same-platform near-duplicate above threshold", () => {
    const result = scanForNearDuplicates({
      hook: "Most crawler logs still treat AI agents as noise.",
      body: "Most crawler logs still treat AI agents as noise. A pattern in the last 30 days of bot traffic shows a measurable share of agentic requests we keep ignoring. The shape of the AI-native web has changed; the analytics stack hasn't.",
      recentHistory: baseHistory,
    });
    expect(result.bestMatch).not.toBeNull();
    expect(result.bestMatch!.score).toBeGreaterThanOrEqual(NEAR_DUP_THRESHOLD);
    expect(result.blocking.length).toBeGreaterThanOrEqual(1);
  });

  it("flags a copy-paste rewritten across platforms (cross-platform near-dup)", () => {
    // Same paragraph re-skinned for Bluesky — a real platform-to-
    // platform leak risk.
    const result = scanForNearDuplicates({
      hook: "most crawler logs still treat ai agents as noise",
      body: "most crawler logs still treat ai agents as noise. a pattern in the last 30 days of bot traffic shows a measurable share of agentic requests we keep ignoring. the shape of the ai-native web has changed; the analytics stack hasn't.",
      recentHistory: baseHistory,
    });
    expect(result.bestMatch?.post.platform).toBe("x");
    expect(result.bestMatch!.score).toBeGreaterThanOrEqual(NEAR_DUP_THRESHOLD);
  });

  it("does NOT flag a platform-native derivative that genuinely rewrites", () => {
    // Same idea, different framing, different vocabulary.
    const result = scanForNearDuplicates({
      hook: "the interesting thing about AI crawlers isn't that they're new",
      body: "spent the week reading bot logs. a few patterns worth writing down. the modern web has two audiences now, and most stacks only acknowledge one. observability built for humans misses the agentic half completely.",
      recentHistory: baseHistory,
    });
    expect(
      (result.bestMatch?.score ?? 0) < NEAR_DUP_THRESHOLD,
    ).toBe(true);
  });

  it("returns no match when history is empty", () => {
    const result = scanForNearDuplicates({
      hook: "x",
      body: "anything",
      recentHistory: [],
    });
    expect(result.bestMatch).toBeNull();
    expect(result.blocking).toEqual([]);
  });
});
