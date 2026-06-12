import { describe, expect, it } from "vitest";
import {
  classifyMediaKind,
  describeProviderMediaReadiness,
  getProviderImageLimitBytes,
  PROVIDER_MEDIA_POLICY,
  prepareProviderMedia,
  type MediaTransformer,
  type PreparedDerivative,
} from "./provider-media-prep";

/**
 * Pure provider-media-prep regression tests.
 *
 * Pins the per-platform limit map + the ready/derivative/blocked
 * decision so the publishers can rely on a single source of truth and
 * the "blob too big" production failure can never reach the provider
 * API again.
 */

const MB = 1024 * 1024;

describe("PROVIDER_MEDIA_POLICY map", () => {
  it("Bluesky enforces a sub-2MB image ceiling with a safety margin", () => {
    const p = PROVIDER_MEDIA_POLICY.bluesky;
    expect(p.uploadsImageBytes).toBe(true);
    expect(p.maxImageBytes).toBeLessThan(2_000_000);
    expect(p.hardImageBytes).toBe(2_000_000);
    expect(getProviderImageLimitBytes("bluesky")).toBe(p.maxImageBytes);
  });

  it("X enforces an image ceiling and uploads bytes", () => {
    const p = PROVIDER_MEDIA_POLICY.x;
    expect(p.uploadsImageBytes).toBe(true);
    expect(p.maxImageBytes).not.toBeNull();
  });

  it("URL-fetch platforms (telegram/devto/hashnode) do NOT upload bytes and have no enforced ceiling", () => {
    for (const platform of ["telegram", "devto", "hashnode"] as const) {
      expect(PROVIDER_MEDIA_POLICY[platform].uploadsImageBytes).toBe(false);
      expect(getProviderImageLimitBytes(platform)).toBeNull();
    }
  });
});

describe("classifyMediaKind", () => {
  it("classifies images, gif as animation, and video", () => {
    expect(classifyMediaKind("image/png")).toBe("image");
    expect(classifyMediaKind("image/gif")).toBe("animation");
    expect(classifyMediaKind("video/mp4")).toBe("video");
  });
  it("falls back to creativeType when MIME is absent", () => {
    expect(classifyMediaKind(null, "video")).toBe("video");
    expect(classifyMediaKind(null, "image")).toBe("image");
    expect(classifyMediaKind(null, null)).toBe("unknown");
  });
});

describe("prepareProviderMedia — Bluesky images", () => {
  it("blocks a Bluesky image over the limit (the production failure)", async () => {
    // 2,070,497 bytes — the exact production payload that triggered
    // "blob too big. maximum 2000000, got 2070497".
    const result = await prepareProviderMedia({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 2_070_497,
      creativeType: "image",
      originalCreativeId: "cr_1",
    });
    expect(result.status).toBe("blocked");
    expect(result.reasonCode).toBe("media_too_large_for_platform");
    expect(result.reasonDetail).toMatch(/limit/i);
    expect(result.metadata.original_creative_id).toBe("cr_1");
    expect(result.metadata.media_preparation_status).toBe("blocked");
  });

  it("passes a Bluesky image under the limit using the original", async () => {
    const result = await prepareProviderMedia({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 900_000,
      creativeType: "image",
    });
    expect(result.status).toBe("ready");
    expect(result.derivative).toBeNull();
    expect(result.reasonCode).toBeNull();
  });

  it("blocks an unsupported image format for Bluesky", async () => {
    const result = await prepareProviderMedia({
      platform: "bluesky",
      mimeType: "image/tiff",
      sizeBytes: 100_000,
    });
    expect(result.status).toBe("blocked");
    expect(result.reasonCode).toBe("media_format_unsupported_for_platform");
  });

  it("passes through when size is unknown (in-flight guard is the backstop)", async () => {
    const result = await prepareProviderMedia({
      platform: "bluesky",
      mimeType: "image/png",
      sizeBytes: null,
    });
    expect(result.status).toBe("ready");
  });

  it("produces a derivative when a transformer is injected", async () => {
    const derivative: PreparedDerivative = {
      platform: "bluesky",
      originalCreativeId: "cr_2",
      mimeType: "image/jpeg",
      sizeBytes: 1_500_000,
      width: 1600,
      height: 900,
      storageRef: "derivatives/bluesky/cr_2.jpg",
      generatedAt: "2026-06-12T00:00:00.000Z",
    };
    const transformer: MediaTransformer = {
      canPrepareImage: () => true,
      prepareImage: async () => derivative,
    };
    const result = await prepareProviderMedia(
      {
        platform: "bluesky",
        mimeType: "image/jpeg",
        sizeBytes: 5 * MB,
        originalCreativeId: "cr_2",
      },
      { transformer },
    );
    expect(result.status).toBe("derivative");
    expect(result.derivative).toEqual(derivative);
    expect(result.metadata.derivative_used).toBe(true);
    expect(result.metadata.derivative_size_bytes).toBe(1_500_000);
  });
});

describe("prepareProviderMedia — X images", () => {
  it("passes an X image under the limit", async () => {
    const result = await prepareProviderMedia({
      platform: "x",
      mimeType: "image/jpeg",
      sizeBytes: 1_000_000,
    });
    expect(result.status).toBe("ready");
  });
  it("blocks an X image over the limit", async () => {
    const result = await prepareProviderMedia({
      platform: "x",
      mimeType: "image/jpeg",
      sizeBytes: 9 * MB,
    });
    expect(result.status).toBe("blocked");
    expect(result.reasonCode).toBe("media_too_large_for_platform");
  });
});

describe("prepareProviderMedia — URL-fetch platforms unchanged", () => {
  it("passes a large Telegram image through (Telegram fetches by URL)", async () => {
    const result = await prepareProviderMedia({
      platform: "telegram",
      mimeType: "image/jpeg",
      sizeBytes: 9 * MB, // would block on bluesky/x; telegram fetches itself
    });
    expect(result.status).toBe("ready");
  });
  it("passes a large dev.to cover image through", async () => {
    const result = await prepareProviderMedia({
      platform: "devto",
      mimeType: "image/png",
      sizeBytes: 9 * MB,
    });
    expect(result.status).toBe("ready");
  });
});

describe("prepareProviderMedia — video deferral", () => {
  it("blocks video on Bluesky with an explicit not-supported reason", async () => {
    const result = await prepareProviderMedia({
      platform: "bluesky",
      mimeType: "video/mp4",
      sizeBytes: 4 * MB,
      creativeType: "video",
    });
    expect(result.status).toBe("blocked");
    expect(result.reasonCode).toBe("media_video_unsupported");
    expect(result.reasonDetail).toMatch(/not supported yet/i);
  });

  it("blocks video on X with an explicit not-supported reason", async () => {
    const result = await prepareProviderMedia({
      platform: "x",
      mimeType: "video/mp4",
      sizeBytes: 4 * MB,
      creativeType: "video",
    });
    expect(result.status).toBe("blocked");
    expect(result.reasonCode).toBe("media_video_unsupported");
  });

  it("blocks video on Telegram too (adapter sends photos only)", async () => {
    const result = await prepareProviderMedia({
      platform: "telegram",
      mimeType: "video/mp4",
      sizeBytes: 4 * MB,
      creativeType: "video",
    });
    expect(result.status).toBe("blocked");
    expect(result.reasonCode).toBe("media_video_unsupported");
  });
});

describe("describeProviderMediaReadiness — non-blocking approval messaging", () => {
  it("flags an oversized Bluesky image as needing a platform-safe version", () => {
    const note = describeProviderMediaReadiness({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 2_070_497,
    });
    expect(note.needsProviderSafeVersion).toBe(true);
    expect(note.message).toMatch(/platform-safe version for bluesky/i);
  });

  it("says nothing for a within-limit image", () => {
    const note = describeProviderMediaReadiness({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 500_000,
    });
    expect(note.needsProviderSafeVersion).toBe(false);
    expect(note.message).toBeNull();
  });

  it("does not flag URL-fetch platforms for size", () => {
    const note = describeProviderMediaReadiness({
      platform: "telegram",
      mimeType: "image/jpeg",
      sizeBytes: 9 * MB,
    });
    expect(note.needsProviderSafeVersion).toBe(false);
  });
});
