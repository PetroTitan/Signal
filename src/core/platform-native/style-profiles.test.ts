import { describe, expect, it } from "vitest";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import {
  PLATFORM_STYLE_PROFILES,
  getPlatformStyleProfile,
} from "./style-profiles";

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

describe("PLATFORM_STYLE_PROFILES — coverage", () => {
  it("includes every FounderPlatform exactly once", () => {
    for (const p of ALL_PLATFORMS) {
      expect(PLATFORM_STYLE_PROFILES[p]).toBeDefined();
      expect(PLATFORM_STYLE_PROFILES[p].platform).toBe(p);
    }
  });

  it("every profile has non-empty required fields", () => {
    for (const p of ALL_PLATFORMS) {
      const prof = getPlatformStyleProfile(p);
      expect(prof.tone.length).toBeGreaterThan(0);
      expect(prof.pacing.length).toBeGreaterThan(0);
      expect(prof.structure.length).toBeGreaterThan(0);
      expect(prof.ctaStyle.length).toBeGreaterThan(0);
      expect(prof.linkPolicy.length).toBeGreaterThan(0);
      expect(prof.hashtagPolicy.length).toBeGreaterThan(0);
      expect(prof.emojiPolicy.length).toBeGreaterThan(0);
      expect(prof.mediaPolicy.length).toBeGreaterThan(0);
      expect(prof.maxLengthGuidance.length).toBeGreaterThan(0);
    }
  });
});

describe("PLATFORM_STYLE_PROFILES — platform-specific contract", () => {
  it("Reddit profile is discussion-first and warns about new-account links", () => {
    const r = getPlatformStyleProfile("reddit");
    expect(r.tone.toLowerCase()).toMatch(/discussion|community/);
    expect(r.newAccountSafetyNotes.some((n) => /link/i.test(n))).toBe(true);
    expect(r.hashtagPolicy.toLowerCase()).toMatch(/no hashtag/);
  });

  it("X profile is concise and explicitly forbids 'agree?' / 'thoughts?'", () => {
    const x = getPlatformStyleProfile("x");
    expect(x.tone.toLowerCase()).toMatch(/concise|sharp|idea-led/);
    expect(x.hashtagPolicy.toLowerCase()).toMatch(/zero|no/);
    const forbidden = x.forbiddenPatterns.join(" ").toLowerCase();
    expect(forbidden).toMatch(/agree\?|thoughts\?/);
  });

  it("LinkedIn profile forbids 'I'm thrilled' / 'agree?' patterns", () => {
    const li = getPlatformStyleProfile("linkedin");
    const forbidden = li.forbiddenPatterns.join(" ").toLowerCase();
    expect(forbidden).toMatch(/i'm thrilled|i'm honored|i'm humbled/);
    expect(forbidden).toMatch(/agree\?|thoughts\?/);
  });

  it("Bluesky profile is calmer than X and forbids X-style bait", () => {
    const b = getPlatformStyleProfile("bluesky");
    expect(b.tone.toLowerCase()).toMatch(/calm|reflective|internet-native/);
    const forbidden = b.forbiddenPatterns.join(" ").toLowerCase();
    expect(forbidden).toMatch(/blew up|rage|engagement/);
  });

  it("Telegram profile is compact + notification-respectful", () => {
    const t = getPlatformStyleProfile("telegram");
    expect(t.tone.toLowerCase()).toMatch(/direct|compact|update/);
    expect(t.density).toBe("high");
  });

  it("dev.to profile is article-shaped, not status-post", () => {
    const d = getPlatformStyleProfile("devto");
    expect(d.tone.toLowerCase()).toMatch(/technical|educational|article/);
    expect(d.structure.toLowerCase()).toMatch(/section|h2|article/);
  });

  it("Hashnode profile is architecture / design rationale", () => {
    const h = getPlatformStyleProfile("hashnode");
    expect(h.tone.toLowerCase()).toMatch(/architecture|design rationale|engineering narrative/);
  });

  it("Instagram profile is visual-first; caption supports the visual", () => {
    const i = getPlatformStyleProfile("instagram");
    expect(i.tone.toLowerCase()).toMatch(/visual-first|caption/);
  });

  it("YouTube profile names chapters + thumbnail expectations", () => {
    const y = getPlatformStyleProfile("youtube");
    expect(y.structure.toLowerCase()).toMatch(/title|chapter/);
  });

  it("Indie Hackers profile forbids fake-traction patterns", () => {
    const ih = getPlatformStyleProfile("indie_hackers");
    const forbidden = ih.forbiddenPatterns.join(" ").toLowerCase();
    expect(forbidden).toMatch(/fake mrr|exaggerated/);
  });

  it("Threads profile is lightweight and forbids 'comment below' / 'follow for daily'", () => {
    const t = getPlatformStyleProfile("threads");
    expect(t.tone.toLowerCase()).toMatch(/lightweight|conversational/);
    const forbidden = t.forbiddenPatterns.join(" ").toLowerCase();
    expect(forbidden).toMatch(/comment below|follow for daily/);
  });
});

describe("Cross-platform differentiation in the profile data itself", () => {
  it("no two platforms share the exact same tone string (forces distinct voice)", () => {
    const tones = ALL_PLATFORMS.map((p) => getPlatformStyleProfile(p).tone);
    const unique = new Set(tones);
    expect(unique.size).toBe(tones.length);
  });

  it("no two platforms share the exact same ctaStyle string", () => {
    const ctas = ALL_PLATFORMS.map((p) => getPlatformStyleProfile(p).ctaStyle);
    const unique = new Set(ctas);
    expect(unique.size).toBe(ctas.length);
  });

  it("no two platforms share the exact same structure string", () => {
    const structures = ALL_PLATFORMS.map(
      (p) => getPlatformStyleProfile(p).structure,
    );
    const unique = new Set(structures);
    expect(unique.size).toBe(structures.length);
  });
});
