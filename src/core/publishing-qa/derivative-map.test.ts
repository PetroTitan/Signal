import { describe, expect, it } from "vitest";
import { derivativesFor, legalSourcesFor, DERIVATIVE_MAP } from "./derivative-map";
import type { FounderPlatform } from "@/core/publishing/platform-guidance";

describe("DERIVATIVE_MAP integrity", () => {
  it("no rule lists its own source as a target", () => {
    for (const [source, rules] of Object.entries(DERIVATIVE_MAP) as Array<
      [FounderPlatform, ReadonlyArray<{ target: FounderPlatform }>]
    >) {
      for (const r of rules) {
        expect(r.target).not.toBe(source);
      }
    }
  });

  it("every rule carries a non-empty 'shape' description", () => {
    for (const rules of Object.values(DERIVATIVE_MAP)) {
      for (const r of rules) {
        expect(r.shape.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("derivativesFor", () => {
  it("Hashnode long-form derives into devto/linkedin/x/bluesky/youtube", () => {
    const targets = derivativesFor("hashnode").map((r) => r.target);
    expect(targets).toEqual(
      expect.arrayContaining(["devto", "linkedin", "x", "bluesky", "youtube"]),
    );
  });

  it("Telegram changelog has at least one derivative", () => {
    expect(derivativesFor("telegram").length).toBeGreaterThan(0);
  });
});

describe("legalSourcesFor", () => {
  it("X has Hashnode/LinkedIn/Bluesky/Threads/IndieHackers/Telegram/YouTube as legal sources", () => {
    const sources = legalSourcesFor("x");
    expect(sources).toEqual(
      expect.arrayContaining([
        "hashnode",
        "linkedin",
        "bluesky",
        "threads",
        "indie_hackers",
        "telegram",
        "youtube",
      ]),
    );
  });
});
