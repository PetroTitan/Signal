import { describe, expect, it } from "vitest";
import { getPlatformAdapter, listPlatformAdapters } from "./registry";
import {
  legacyPlatformNativeShape,
  type PlatformNativeShape,
} from "../publishing-intent";
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

const STUB_PLATFORMS: ReadonlyArray<PublishPlatform> = [
  "reddit",
  "x",
  "linkedin",
  "devto",
  "hashnode",
  "youtube",
  "threads",
  "instagram",
  "telegram",
];

describe("registry — every PublishPlatform has an adapter", () => {
  for (const platform of ALL_PLATFORMS) {
    it(`getPlatformAdapter("${platform}") returns an adapter`, () => {
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

describe("registry — only Bluesky is non-stub in this PR", () => {
  it("bluesky adapter has stub=false", () => {
    expect(getPlatformAdapter("bluesky")?.capabilities.stub).toBe(false);
  });

  for (const platform of STUB_PLATFORMS) {
    it(`${platform} adapter has stub=true`, () => {
      expect(getPlatformAdapter(platform)?.capabilities.stub).toBe(true);
    });
  }
});

describe("stub adapters — refuse any non-legacy shape", () => {
  function realIntent(platform: PublishPlatform): PlatformNativeShape {
    return {
      ...legacyPlatformNativeShape(platform),
      intent: "new_post",
    };
  }

  for (const platform of STUB_PLATFORMS) {
    it(`${platform}.validateShape rejects intent=new_post with adapter_not_implemented`, () => {
      const adapter = getPlatformAdapter(platform)!;
      const blockers = adapter.validateShape(realIntent(platform));
      expect(blockers.map((b) => b.code)).toContain("adapter_not_implemented");
    });

    it(`${platform}.buildPreview returns format=unknown + not_implemented blocker (even for legacy shape)`, () => {
      const adapter = getPlatformAdapter(platform)!;
      const preview = adapter.buildPreview({
        title: null,
        body: "hello",
        identity: { displayName: null, handle: null, avatarUrl: null },
        creative: null,
        shape: legacyPlatformNativeShape(platform),
      });
      expect(preview.format).toBe("unknown");
      expect(preview.parts).toHaveLength(0);
      expect(preview.blockers.map((b) => b.code)).toContain(
        "adapter_not_implemented",
      );
    });

    it(`${platform}.validateShape accepts legacy shape without blockers`, () => {
      const adapter = getPlatformAdapter(platform)!;
      const blockers = adapter.validateShape(
        legacyPlatformNativeShape(platform),
      );
      expect(blockers).toEqual([]);
    });
  }
});

describe("stub adapters — do NOT call into per-platform code", () => {
  // This is an architectural assertion: stub adapters do NOT touch
  // existing publishers / transformers / previews. If a stub did, a
  // cross-platform regression in one provider would silently leak
  // into the stubs for every other platform.
  //
  // We can't directly assert "did not import", but we CAN assert the
  // stub output shape is identical across all stub platforms — i.e.
  // the stubs are platform-name-only differences, not behavior
  // differences. A wrapper that called into transformers/x.ts would
  // produce different output for X vs Reddit.
  it("every stub adapter produces structurally identical output for the same input", () => {
    const previews = STUB_PLATFORMS.map((platform) => {
      const adapter = getPlatformAdapter(platform)!;
      return adapter.buildPreview({
        title: null,
        body: "shared body",
        identity: { displayName: null, handle: null, avatarUrl: null },
        creative: null,
        shape: legacyPlatformNativeShape(platform),
      });
    });
    // Each preview's `platform` field differs, but `format`, `parts`,
    // and blocker codes are identical across all stubs.
    const formats = previews.map((p) => p.format);
    expect(new Set(formats)).toEqual(new Set(["unknown"]));
    const partCounts = previews.map((p) => p.parts.length);
    expect(new Set(partCounts)).toEqual(new Set([0]));
    const blockerCodes = previews.map((p) =>
      p.blockers.map((b) => b.code).sort().join(","),
    );
    expect(new Set(blockerCodes).size).toBe(1);
  });
});
