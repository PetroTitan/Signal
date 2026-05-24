import { describe, expect, it } from "vitest";
import {
  detectCrossPlatformCopypaste,
  __internal,
} from "./cross-platform-differentiation";
import { getCreativeDirection } from "./creative-direction";
import type { PlatformNativeDraft } from "./types";

function draft(overrides: Partial<PlatformNativeDraft>): PlatformNativeDraft {
  return {
    platform: "x",
    title: null,
    hook: "",
    body: "",
    cta: null,
    format: "single_post",
    creativeDirection: getCreativeDirection("x"),
    riskLevel: "low",
    warnings: [],
    transformationNotes: [],
    ...overrides,
  };
}

// =====================================================================
// Jaccard + tokenize unit tests
// =====================================================================

describe("__internal.tokenize + jaccard", () => {
  it("tokenize lowercases, strips punctuation, drops short tokens", () => {
    const t = __internal.tokenize("Hello, WORLD! it's a test.");
    expect(t).toContain("hello");
    expect(t).toContain("world");
    expect(t).toContain("test");
    expect(t).not.toContain("a"); // dropped: 1 char
    expect(t).not.toContain("it"); // dropped: 2 chars
  });

  it("jaccard returns 1 for identical sets and 0 for disjoint", () => {
    const a = new Set(["one", "two", "three"]);
    const b = new Set(["one", "two", "three"]);
    expect(__internal.jaccard(a, b)).toBe(1);
    const c = new Set(["four", "five"]);
    expect(__internal.jaccard(a, c)).toBe(0);
  });
});

// =====================================================================
// detectCrossPlatformCopypaste
// =====================================================================

describe("detectCrossPlatformCopypaste — hook similarity", () => {
  it("flags identical opening hooks across two platforms (Jaccard >= 0.6)", () => {
    const x = draft({
      platform: "x",
      hook: "We refactored authentication tokens with envelope encryption.",
      body: "...",
    });
    const linkedin = draft({
      platform: "linkedin",
      hook: "We refactored authentication tokens with envelope encryption.",
      body: "...",
    });
    const findings = detectCrossPlatformCopypaste({
      candidate: x,
      siblings: [linkedin],
    });
    expect(findings.some((f) => f.code === "shared_hook")).toBe(true);
  });

  it("does NOT flag distinctly worded hooks on the same idea", () => {
    const x = draft({
      platform: "x",
      hook: "Encrypted refresh tokens cut our incident rate to zero.",
    });
    const bluesky = draft({
      platform: "bluesky",
      hook: "A quiet observation: token storage and incident rate are linked.",
    });
    const findings = detectCrossPlatformCopypaste({
      candidate: x,
      siblings: [bluesky],
    });
    expect(findings.filter((f) => f.code === "shared_hook")).toEqual([]);
  });

  it("ignores siblings on the same platform (no self-comparison)", () => {
    const a = draft({ platform: "x", hook: "same hook" });
    const b = draft({ platform: "x", hook: "same hook" });
    const findings = detectCrossPlatformCopypaste({
      candidate: a,
      siblings: [b],
    });
    expect(findings).toEqual([]);
  });
});

describe("detectCrossPlatformCopypaste — CTA equality", () => {
  it("flags identical CTA across platforms", () => {
    const a = draft({
      platform: "x",
      hook: "x-specific",
      cta: "Curious how others approach this.",
    });
    const b = draft({
      platform: "linkedin",
      hook: "linkedin-specific",
      cta: "Curious how others approach this.",
    });
    const findings = detectCrossPlatformCopypaste({
      candidate: a,
      siblings: [b],
    });
    expect(findings.some((f) => f.code === "shared_cta")).toBe(true);
  });

  it("treats different CTAs as fine", () => {
    const a = draft({
      platform: "x",
      hook: "x hook",
      cta: "Drop the postmortem link if you have one.",
    });
    const b = draft({
      platform: "linkedin",
      hook: "linkedin hook",
      cta: "We'd be glad to see how you're handling this.",
    });
    const findings = detectCrossPlatformCopypaste({
      candidate: a,
      siblings: [b],
    });
    expect(findings.filter((f) => f.code === "shared_cta")).toEqual([]);
  });
});

describe("detectCrossPlatformCopypaste — structural rhythm", () => {
  it("flags matching paragraph rhythm across platforms", () => {
    const sharedBody =
      "First paragraph statement of the problem.\n\nSecond paragraph naming the tradeoff.\n\nThird paragraph closing the loop.";
    const a = draft({ platform: "x", hook: "a-hook", body: sharedBody });
    const b = draft({
      platform: "linkedin",
      hook: "b-hook",
      body: sharedBody,
    });
    const findings = detectCrossPlatformCopypaste({
      candidate: a,
      siblings: [b],
    });
    expect(findings.some((f) => f.code === "shared_structure")).toBe(true);
  });
});

describe("detectCrossPlatformCopypaste — severity", () => {
  it("findings are warn-level (not block)", () => {
    const a = draft({
      platform: "x",
      hook: "same hook same hook same hook",
    });
    const b = draft({
      platform: "linkedin",
      hook: "same hook same hook same hook",
    });
    const findings = detectCrossPlatformCopypaste({
      candidate: a,
      siblings: [b],
    });
    for (const f of findings) {
      expect(f.severity).toBe("warn");
      expect(f.category).toBe("cross_platform_copypaste");
    }
  });
});
