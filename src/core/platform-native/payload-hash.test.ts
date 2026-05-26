import { describe, expect, it } from "vitest";
import {
  computeProviderPayloadHash,
  isApprovedPayloadStillCurrent,
} from "./payload-hash";
import type { ProviderPayloadPreview } from "./publishing-intent";

function basePreview(
  over: Partial<ProviderPayloadPreview> = {},
): ProviderPayloadPreview {
  return {
    platform: "bluesky",
    intent: "new_post",
    format: "single_post",
    parts: [
      {
        index: 1,
        text: "hello",
        media: { attached: false, target: "none", altText: null },
      },
    ],
    warnings: [],
    blockers: [],
    ...over,
  };
}

describe("computeProviderPayloadHash — determinism", () => {
  it("identical input → identical hash", async () => {
    const a = await computeProviderPayloadHash(basePreview());
    const b = await computeProviderPayloadHash(basePreview());
    expect(a).toBe(b);
  });

  it("hash format is sha256:v1:<64-hex>", async () => {
    const hash = await computeProviderPayloadHash(basePreview());
    expect(hash).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
  });

  it("warnings do NOT affect the hash (advisory only)", async () => {
    const a = await computeProviderPayloadHash(basePreview());
    const b = await computeProviderPayloadHash(
      basePreview({ warnings: ["a warning that changes nothing"] }),
    );
    expect(a).toBe(b);
  });
});

describe("computeProviderPayloadHash — change detection", () => {
  it("changed text → different hash", async () => {
    const a = await computeProviderPayloadHash(basePreview());
    const b = await computeProviderPayloadHash(
      basePreview({
        parts: [
          {
            index: 1,
            text: "different",
            media: { attached: false, target: "none", altText: null },
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changed thread part count → different hash", async () => {
    const a = await computeProviderPayloadHash(basePreview());
    const b = await computeProviderPayloadHash(
      basePreview({
        parts: [
          {
            index: 1,
            text: "hello",
            media: { attached: false, target: "none", altText: null },
          },
          {
            index: 2,
            text: "world",
            media: { attached: false, target: "none", altText: null },
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changed media attachment → different hash", async () => {
    const a = await computeProviderPayloadHash(basePreview());
    const b = await computeProviderPayloadHash(
      basePreview({
        parts: [
          {
            index: 1,
            text: "hello",
            media: {
              attached: true,
              target: "this_part",
              altText: "a description",
            },
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changed alt text → different hash", async () => {
    const a = await computeProviderPayloadHash(
      basePreview({
        parts: [
          {
            index: 1,
            text: "hello",
            media: { attached: true, target: "this_part", altText: "alt A" },
          },
        ],
      }),
    );
    const b = await computeProviderPayloadHash(
      basePreview({
        parts: [
          {
            index: 1,
            text: "hello",
            media: { attached: true, target: "this_part", altText: "alt B" },
          },
        ],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("changed intent → different hash", async () => {
    const a = await computeProviderPayloadHash(
      basePreview({ intent: "new_post" }),
    );
    const b = await computeProviderPayloadHash(basePreview({ intent: "thread" }));
    expect(a).not.toBe(b);
  });

  it("changed format → different hash", async () => {
    const a = await computeProviderPayloadHash(
      basePreview({ format: "single_post" }),
    );
    const b = await computeProviderPayloadHash(basePreview({ format: "thread" }));
    expect(a).not.toBe(b);
  });

  it("added blocker → different hash (blockers are part of the publish contract)", async () => {
    const a = await computeProviderPayloadHash(basePreview());
    const b = await computeProviderPayloadHash(
      basePreview({
        blockers: [{ code: "test_blocker", message: "test" }],
      }),
    );
    expect(a).not.toBe(b);
  });

  it("swapped part order → different hash (order is load-bearing)", async () => {
    const ordered = basePreview({
      parts: [
        {
          index: 1,
          text: "first",
          media: { attached: false, target: "none", altText: null },
        },
        {
          index: 2,
          text: "second",
          media: { attached: false, target: "none", altText: null },
        },
      ],
    });
    const swapped = basePreview({
      parts: [
        {
          index: 1,
          text: "second",
          media: { attached: false, target: "none", altText: null },
        },
        {
          index: 2,
          text: "first",
          media: { attached: false, target: "none", altText: null },
        },
      ],
    });
    expect(await computeProviderPayloadHash(ordered)).not.toBe(
      await computeProviderPayloadHash(swapped),
    );
  });
});

describe("isApprovedPayloadStillCurrent — stale detection", () => {
  it("returns true when approved hash matches current", async () => {
    const preview = basePreview();
    const hash = await computeProviderPayloadHash(preview);
    expect(await isApprovedPayloadStillCurrent(hash, preview)).toBe(true);
  });

  it("returns false when approved hash is null (no approval bound)", async () => {
    expect(await isApprovedPayloadStillCurrent(null, basePreview())).toBe(false);
  });

  it("returns false when text drifted after approval", async () => {
    const approvedPreview = basePreview();
    const approvedHash = await computeProviderPayloadHash(approvedPreview);
    const driftedPreview = basePreview({
      parts: [
        {
          index: 1,
          text: "edited body",
          media: { attached: false, target: "none", altText: null },
        },
      ],
    });
    expect(await isApprovedPayloadStillCurrent(approvedHash, driftedPreview)).toBe(
      false,
    );
  });

  it("returns false when malformed hash supplied", async () => {
    const preview = basePreview();
    expect(await isApprovedPayloadStillCurrent("not-a-real-hash", preview)).toBe(
      false,
    );
  });
});
