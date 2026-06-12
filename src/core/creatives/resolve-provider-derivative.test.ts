import { describe, expect, it } from "vitest";
import { resolveProviderMediaForPublish } from "./resolve-provider-derivative";
import { createImageDerivativeTransformer } from "./image-derivative-transformer";
import type { PublishCreative, PublishRequest } from "@/core/publishing/publishing-types";

/**
 * Resolver tests — the orchestrator-facing decision layer.
 *
 * The real sharp engine + storage are bypassed via an injected
 * transformer factory; a throwing db proves the resolver is resilient
 * (cache read + metadata persist are best-effort, never fatal).
 */

// A db that throws on every call: cache reads degrade to "miss" and
// metadata persistence fails silently — neither blocks the publish.
const throwingDb = {
  from() {
    throw new Error("no db in test");
  },
} as unknown as Parameters<typeof resolveProviderMediaForPublish>[0]["db"];

function creative(over: Partial<PublishCreative> = {}): PublishCreative {
  return {
    id: "cr-1",
    creativeType: "image",
    sourceType: "uploaded",
    assetUrl: "https://cdn.example.com/original.png",
    sourceUrl: null,
    altText: "a dog",
    mimeType: "image/jpeg",
    sizeBytes: 5_000_000,
    ...over,
  };
}

function request(c: PublishCreative | null): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "bluesky",
    accountId: "acct-1",
    productId: null,
    title: null,
    body: "hello world",
    linkUrl: null,
    target: null,
    mode: "live",
    creative: c,
  };
}

function derivativeFactory(
  behavior: "ok" | "throw",
): typeof createImageDerivativeTransformer {
  return (() => ({
    canPrepareImage: () => true,
    prepareImage: async () => {
      if (behavior === "throw") throw new Error("transform failed");
      return {
        platform: "bluesky" as const,
        originalCreativeId: "cr-1",
        mimeType: "image/webp",
        sizeBytes: 1_400_000,
        width: 1600,
        height: 900,
        storageRef: "ws-1/derivatives/bluesky/cr-1/hash.webp",
        publicUrl: "https://cdn.example.com/derivatives/hash.webp",
        sourceSizeBytes: 5_000_000,
        transform: {
          outputFormat: "image/webp",
          quality: 72,
          maxWidth: 1600,
          maxHeight: null,
          targetBytes: 1_900_000,
        },
        generatedAt: "2026-06-12T00:00:00.000Z",
      };
    },
  })) as unknown as typeof createImageDerivativeTransformer;
}

describe("resolveProviderMediaForPublish", () => {
  it("no creative → ready (text-only unchanged)", async () => {
    const r = await resolveProviderMediaForPublish({
      platform: "bluesky",
      request: request(null),
      db: throwingDb,
    });
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") expect(r.creative).toBeNull();
  });

  it("within-limit image → ready, original creative untouched", async () => {
    const c = creative({ sizeBytes: 900_000 });
    const r = await resolveProviderMediaForPublish({
      platform: "bluesky",
      request: request(c),
      db: throwingDb,
      transformerFactory: derivativeFactory("ok"),
    });
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.creative?.assetUrl).toBe("https://cdn.example.com/original.png");
      expect(r.creative?.sizeBytes).toBe(900_000);
    }
  });

  it("oversized image → derivative; creative rewritten to the derivative, original preserved", async () => {
    const c = creative({ sizeBytes: 5_000_000 });
    const r = await resolveProviderMediaForPublish({
      platform: "bluesky",
      request: request(c),
      db: throwingDb,
      transformerFactory: derivativeFactory("ok"),
    });
    expect(r.kind).toBe("derivative");
    if (r.kind === "derivative") {
      // Rewritten publish payload points at the derivative bytes…
      expect(r.creative.assetUrl).toBe(
        "https://cdn.example.com/derivatives/hash.webp",
      );
      expect(r.creative.sizeBytes).toBe(1_400_000);
      expect(r.creative.mimeType).toBe("image/webp");
      // …but the alt text + id are preserved from the original.
      expect(r.creative.altText).toBe("a dog");
      expect(r.creative.id).toBe("cr-1");
      // …and the ORIGINAL request creative object is unmutated.
      expect(c.assetUrl).toBe("https://cdn.example.com/original.png");
      expect(c.sizeBytes).toBe(5_000_000);
      expect(r.metadata.derivative_used).toBe(true);
      expect(r.metadata.derivative_storage_path).toBe(
        "ws-1/derivatives/bluesky/cr-1/hash.webp",
      );
      expect(r.metadata.media_preparation_status).toBe("derivative");
    }
  });

  it("derivative generation failure → blocked (status=blocked), NO text-only downgrade", async () => {
    const c = creative({ sizeBytes: 5_000_000 });
    const r = await resolveProviderMediaForPublish({
      platform: "bluesky",
      request: request(c),
      db: throwingDb,
      transformerFactory: derivativeFactory("throw"),
    });
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.outcome.status).toBe("blocked");
      expect(r.outcome.reasonCode).toBe("media_derivative_failed");
    }
  });

  it("oversized animated GIF → blocked with the GIF reason (transformer never consulted)", async () => {
    const c = creative({ mimeType: "image/gif", creativeType: "animation", sizeBytes: 5_000_000 });
    const r = await resolveProviderMediaForPublish({
      platform: "bluesky",
      request: request(c),
      db: throwingDb,
      transformerFactory: derivativeFactory("throw"), // would throw if called
    });
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.outcome.reasonCode).toBe("media_animated_gif_unsupported");
    }
  });

  it("video creative → blocked with the deferred reason", async () => {
    const c = creative({ mimeType: "video/mp4", creativeType: "video", sizeBytes: 4_000_000 });
    const r = await resolveProviderMediaForPublish({
      platform: "bluesky",
      request: request(c),
      db: throwingDb,
      transformerFactory: derivativeFactory("ok"),
    });
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.outcome.reasonCode).toBe("media_video_unsupported");
    }
  });
});
