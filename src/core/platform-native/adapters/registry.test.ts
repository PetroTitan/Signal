import { describe, expect, it } from "vitest";
import { getPlatformAdapter, listPlatformAdapters } from "./registry";
import { legacyPlatformNativeShape } from "../publishing-intent";
import type { PublishPlatform } from "@/core/publishing/publishing-types";

const ALL_PLATFORMS: ReadonlyArray<PublishPlatform> = [
  "reddit",
  "x",
  "linkedin",
  "devto",
  "hashnode",
  "bluesky",
  "youtube",
  "threads",
  "instagram",
  "telegram",
];

describe("registry — every PublishPlatform has an adapter", () => {
  for (const platform of ALL_PLATFORMS) {
    it(`getPlatformAdapter("${platform}") returns an adapter with matching platform`, () => {
      const adapter = getPlatformAdapter(platform);
      expect(adapter).not.toBeNull();
      expect(adapter?.platform).toBe(platform);
    });
  }

  it("listPlatformAdapters returns one adapter per platform", () => {
    const adapters = listPlatformAdapters();
    expect(adapters.length).toBe(ALL_PLATFORMS.length);
    expect(new Set(adapters.map((a) => a.platform))).toEqual(
      new Set(ALL_PLATFORMS),
    );
  });
});

describe("registry — every adapter is now REAL (no stubs)", () => {
  // Phase F6.3 ships real adapters for all 9 remaining platforms.
  // No platform should advertise `capabilities.stub = true` anymore.
  // (Future platforms added to the PublishPlatform union must ship
  // their adapter in the same PR; this test fails fast if anyone
  // re-adds a stub.)
  for (const platform of ALL_PLATFORMS) {
    it(`${platform} adapter is real (capabilities.stub === false)`, () => {
      expect(getPlatformAdapter(platform)?.capabilities.stub).toBe(false);
    });
  }
});

describe("registry — legacy shape (intent=unknown) is accepted by every adapter", () => {
  // Legacy compatibility contract: pre-F6 rows have no operator
  // intent. Every real adapter must accept the legacy shape without
  // a blocker so existing rows continue to render in the compose
  // modal.
  for (const platform of ALL_PLATFORMS) {
    it(`${platform}.validateShape(legacy) returns no blockers`, () => {
      const adapter = getPlatformAdapter(platform)!;
      const legacy = legacyPlatformNativeShape(platform);
      expect(adapter.validateShape(legacy)).toEqual([]);
    });
  }
});

describe("registry — per-platform isolation invariants", () => {
  // Adapters MUST NOT pollute each other. Calling buildPreview on
  // one adapter should never mutate or affect the output of another.
  it("each adapter produces output keyed to its own platform", () => {
    const renderInput = (platform: PublishPlatform) => ({
      title: "shared title",
      body: "shared body that is short",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: null,
      shape: legacyPlatformNativeShape(platform),
    });
    for (const platform of ALL_PLATFORMS) {
      const adapter = getPlatformAdapter(platform)!;
      const preview = adapter.buildPreview(renderInput(platform));
      expect(preview.platform).toBe(platform);
    }
  });
});
