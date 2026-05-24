import { describe, expect, it } from "vitest";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import {
  buildPlatformShape,
  buildCtaInstruction,
  buildNewAccountAddendum,
} from "./prompt-shape";

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

describe("buildPlatformShape", () => {
  it("produces a multi-section block for every platform", () => {
    for (const p of ALL_PLATFORMS) {
      const shape = buildPlatformShape(p);
      expect(shape).toContain("Tone:");
      expect(shape).toContain("Density:");
      expect(shape).toContain("Pacing:");
      expect(shape).toContain("Structure:");
      expect(shape).toContain("CTA style:");
      expect(shape).toContain("Length:");
      expect(shape).toContain("Link policy:");
      expect(shape).toContain("Hashtag policy:");
      expect(shape).toContain("Emoji policy:");
      expect(shape).toContain("Media policy:");
    }
  });

  it("includes the forbidden-patterns sub-list", () => {
    const shape = buildPlatformShape("linkedin");
    expect(shape.toLowerCase()).toContain("do not write");
    expect(shape.toLowerCase()).toContain("i'm thrilled");
  });

  it("includes creative-direction brief + risk notes", () => {
    const shape = buildPlatformShape("instagram");
    expect(shape).toContain("Creative direction");
    expect(shape.toLowerCase()).toContain("media required");
  });

  it("different platforms produce materially different shape blocks", () => {
    const shapes = ALL_PLATFORMS.map((p) => buildPlatformShape(p));
    // Each block should be unique — same canonical idea would get
    // different shaping per platform.
    expect(new Set(shapes).size).toBe(shapes.length);
  });

  it("Reddit shape is discussion-first (mentions discussion or community)", () => {
    const s = buildPlatformShape("reddit").toLowerCase();
    expect(s).toMatch(/discussion|community/);
  });

  it("X shape names the no-hashtag rule explicitly", () => {
    const s = buildPlatformShape("x").toLowerCase();
    expect(s).toMatch(/zero hashtag|no hashtag/);
  });

  it("YouTube shape names thumbnail + chapters expectations", () => {
    const s = buildPlatformShape("youtube").toLowerCase();
    expect(s).toContain("thumbnail");
    expect(s).toContain("chapter");
  });

  it("Instagram shape declares media REQUIRED", () => {
    const s = buildPlatformShape("instagram").toLowerCase();
    expect(s).toContain("media required");
  });
});

describe("buildCtaInstruction", () => {
  it("is platform-scoped — each platform gets a different CTA instruction", () => {
    const instructions = ALL_PLATFORMS.map((p) => buildCtaInstruction(p));
    expect(new Set(instructions).size).toBe(instructions.length);
  });

  it("names the platform inside the instruction", () => {
    for (const p of ALL_PLATFORMS) {
      const inst = buildCtaInstruction(p);
      expect(inst).toContain(p);
    }
  });
});

describe("buildNewAccountAddendum", () => {
  it("returns a non-empty block for platforms with new-account notes", () => {
    expect(buildNewAccountAddendum("x").length).toBeGreaterThan(0);
    expect(buildNewAccountAddendum("reddit").length).toBeGreaterThan(0);
  });

  it("addendum copy names the warming state explicitly", () => {
    const a = buildNewAccountAddendum("x").toLowerCase();
    expect(a).toContain("warming");
  });
});
