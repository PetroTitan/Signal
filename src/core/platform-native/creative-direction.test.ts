import { describe, expect, it } from "vitest";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";
import {
  PLATFORM_CREATIVE_DIRECTION,
  getCreativeDirection,
} from "./creative-direction";

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

describe("PLATFORM_CREATIVE_DIRECTION — coverage", () => {
  it("includes every FounderPlatform exactly once", () => {
    for (const p of ALL_PLATFORMS) {
      expect(PLATFORM_CREATIVE_DIRECTION[p]).toBeDefined();
    }
  });

  it("every direction has a non-empty brief + at least one risk note", () => {
    for (const p of ALL_PLATFORMS) {
      const c = getCreativeDirection(p);
      expect(c.mediaPromptOrBrief.length).toBeGreaterThan(20);
      expect(c.mediaRiskNotes.length).toBeGreaterThan(0);
    }
  });
});

describe("PLATFORM_CREATIVE_DIRECTION — per-platform contract", () => {
  it("Instagram REQUIRES media; carousel/reel/static", () => {
    const c = getCreativeDirection("instagram");
    expect(c.mediaRequired).toBe(true);
    expect(["carousel", "short_video", "static_image"]).toContain(c.mediaType);
  });

  it("YouTube REQUIRES media; type is thumbnail", () => {
    const c = getCreativeDirection("youtube");
    expect(c.mediaRequired).toBe(true);
    expect(c.mediaType).toBe("thumbnail");
  });

  it("LinkedIn brief points at a real product carousel/diagram/screenshot", () => {
    const c = getCreativeDirection("linkedin");
    expect(c.mediaType).toBe("carousel");
    expect(c.mediaPromptOrBrief.toLowerCase()).toMatch(
      /carousel|diagram|screenshot/,
    );
  });

  it("Hashnode recommends an architecture diagram (not generic AI art)", () => {
    const c = getCreativeDirection("hashnode");
    expect(c.mediaType).toBe("diagram");
    const risks = c.mediaRiskNotes.join(" ").toLowerCase();
    expect(risks).toMatch(/generic|ai art/);
  });

  it("dev.to suggests hero image but warns against generic stock", () => {
    const c = getCreativeDirection("devto");
    expect(c.mediaType).toBe("hero_image");
    const risks = c.mediaRiskNotes.join(" ").toLowerCase();
    expect(risks).toMatch(/stock/);
  });

  it("every platform's risk notes ban fabrication of screenshots or numbers", () => {
    for (const p of ALL_PLATFORMS) {
      const risks = getCreativeDirection(p).mediaRiskNotes.join(" ").toLowerCase();
      const bansFabrication =
        risks.includes("fabricat") ||
        risks.includes("do not generate") ||
        risks.includes("do not invent") ||
        risks.includes("operator-supplied") ||
        risks.includes("do not use generic") ||
        risks.includes("real screenshot") ||
        risks.includes("real product") ||
        risks.includes("no fake") ||
        risks.includes("operator must");
      expect(bansFabrication, `${p}: risk notes do not ban fabrication`).toBe(true);
    }
  });

  it("Instagram explicitly bans burned-in hashtag blocks on visuals", () => {
    const c = getCreativeDirection("instagram");
    const risks = c.mediaRiskNotes.join(" ").toLowerCase();
    expect(risks).toMatch(/hashtag block/);
  });

  it("Indie Hackers explicitly bans fake traction charts", () => {
    const c = getCreativeDirection("indie_hackers");
    const risks = c.mediaRiskNotes.join(" ").toLowerCase();
    expect(risks).toMatch(/fake mrr|fake.*traction|traction.*chart/);
  });

  it("Telegram recommends restraint — media only when it adds signal", () => {
    const c = getCreativeDirection("telegram");
    expect(c.mediaRequired).toBe(false);
    expect(c.mediaPromptOrBrief.toLowerCase()).toMatch(
      /signal|notification|push/,
    );
  });

  it("Reddit defaults to text-first (mediaRequired=false, mediaType=none)", () => {
    const c = getCreativeDirection("reddit");
    expect(c.mediaRequired).toBe(false);
    expect(c.mediaType).toBe("none");
  });
});
