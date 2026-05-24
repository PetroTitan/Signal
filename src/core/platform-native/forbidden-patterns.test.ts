import { describe, expect, it } from "vitest";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import {
  PLATFORM_FORBIDDEN_PATTERNS,
  getForbiddenPatterns,
  scanForPlatformViolations,
} from "./forbidden-patterns";

const ALL_PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "reddit",
  "x",
  "bluesky",
  "linkedin",
  "threads",
  "instagram",
  "telegram",
  "devto",
  "hashnode",
  "youtube",
  "indie_hackers",
];

describe("PLATFORM_FORBIDDEN_PATTERNS — coverage", () => {
  it("every platform has at least one platform-specific forbidden pattern", () => {
    for (const p of ALL_PLATFORMS) {
      expect(getForbiddenPatterns(p).length).toBeGreaterThan(0);
    }
  });
});

describe("scanForPlatformViolations", () => {
  it("flags 'agree?' on LinkedIn (and reports CTA location)", () => {
    const violations = scanForPlatformViolations({
      platform: "linkedin",
      hook: "Quick observation on engineering hiring.",
      body: "Three patterns we keep seeing in interview loops.",
      cta: "agree?",
    });
    expect(violations.some((v) => v.pattern === "agree?" && v.location === "cta")).toBe(
      true,
    );
  });

  it("flags 'smash like' on YouTube (body location)", () => {
    const violations = scanForPlatformViolations({
      platform: "youtube",
      hook: "Architecture deep-dive",
      body: "Smash like, and don't forget to subscribe before we start.",
      cta: null,
    });
    expect(violations.some((v) => v.pattern === "smash like")).toBe(true);
    expect(violations.some((v) => v.pattern === "don't forget to subscribe")).toBe(
      true,
    );
  });

  it("flags 'link in bio' on Instagram", () => {
    const violations = scanForPlatformViolations({
      platform: "instagram",
      hook: "behind the scenes today",
      body: "Caption text. Link in bio for more.",
      cta: null,
    });
    expect(violations.some((v) => v.pattern === "link in bio")).toBe(true);
  });

  it("flags 'join now' on Telegram", () => {
    const violations = scanForPlatformViolations({
      platform: "telegram",
      hook: "Channel update",
      body: "New feature shipped. Join now for early access.",
      cta: null,
    });
    expect(violations.some((v) => v.pattern === "join now")).toBe(true);
  });

  it("returns empty when no platform-specific tells are present", () => {
    const violations = scanForPlatformViolations({
      platform: "x",
      hook: "One observation on auth tokens.",
      body: "Storing refresh tokens encrypted at rest changed our incident rate.",
      cta: null,
    });
    expect(violations).toEqual([]);
  });

  it("is case-insensitive", () => {
    const violations = scanForPlatformViolations({
      platform: "linkedin",
      hook: "Quick observation.",
      body: "Body.",
      cta: "AGREE?",
    });
    expect(violations.some((v) => v.pattern === "agree?")).toBe(true);
  });

  it("flags Reddit discussion framing on X (cross-platform leak)", () => {
    const violations = scanForPlatformViolations({
      platform: "x",
      hook: "We refactored auth.",
      body: "Three tradeoffs. Let's discuss.",
      cta: null,
    });
    expect(violations.some((v) => v.pattern === "let's discuss")).toBe(true);
  });

  it("flags fake-traction phrasing on Indie Hackers", () => {
    const violations = scanForPlatformViolations({
      platform: "indie_hackers",
      hook: "Build update",
      body: "Revenue skyrocketed last month.",
      cta: null,
    });
    expect(violations.some((v) => v.pattern === "skyrocketed")).toBe(true);
  });
});

describe("PLATFORM_FORBIDDEN_PATTERNS — coverage signals", () => {
  it("LinkedIn-only patterns include the 'thrilled / honored / humbled' triad", () => {
    const li = getForbiddenPatterns("linkedin").map((s) => s.toLowerCase());
    expect(li).toContain("i'm thrilled");
    expect(li).toContain("i'm honored");
    expect(li).toContain("i'm humbled");
  });

  it("YouTube-only patterns include 'smash like' + 'don't forget to subscribe'", () => {
    const y = getForbiddenPatterns("youtube").map((s) => s.toLowerCase());
    expect(y).toContain("smash like");
    expect(y).toContain("don't forget to subscribe");
  });

  it("Reddit and Indie Hackers patterns target community-tone violations specifically", () => {
    const r = getForbiddenPatterns("reddit").join(" ").toLowerCase();
    expect(r).toMatch(/must read|blew up|huge news/);
    const ih = getForbiddenPatterns("indie_hackers").join(" ").toLowerCase();
    expect(ih).toMatch(/crushing it|killing it|skyrocketed|we just hit/);
  });

  it("PLATFORM_FORBIDDEN_PATTERNS object actually exports the same map", () => {
    expect(PLATFORM_FORBIDDEN_PATTERNS.linkedin.length).toBeGreaterThan(0);
  });
});
