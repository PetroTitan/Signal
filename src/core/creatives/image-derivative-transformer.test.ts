import { describe, expect, it, vi } from "vitest";
import {
  createImageDerivativeTransformer,
  isCachedDerivativeValid,
  preparedToRecord,
  type ImageEngine,
  type ProviderDerivativeRecord,
} from "./image-derivative-transformer";

/**
 * Image-derivative-transformer tests.
 *
 * Most cases use an injected fake image engine + fake storage so they
 * run fast and deterministically without the native sharp addon or a
 * real bucket. One end-to-end case exercises the REAL sharp engine to
 * prove an oversized image is actually compressed under the target.
 */

// ---- fakes ----------------------------------------------------------

function fakeStorage(opts?: { uploadError?: string }) {
  const uploads: Array<{ path: string; bytes: number; contentType?: string }> = [];
  const db = {
    uploads,
    storage: {
      from() {
        return {
          async upload(path: string, buf: Buffer, o?: { contentType?: string }) {
            uploads.push({ path, bytes: buf.length, contentType: o?.contentType });
            return opts?.uploadError
              ? { error: { message: opts.uploadError } }
              : { error: null };
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `https://cdn.example.com/${path}` } };
          },
        };
      },
    },
  };
  return db as unknown as Parameters<
    typeof createImageDerivativeTransformer
  >[0]["db"] & { uploads: typeof uploads };
}

/** Engine where output size shrinks as width/quality drop, so the
 *  ladder must step down to fit a tight target. */
function laddderEngine(pages = 1): ImageEngine {
  return {
    async probe() {
      return { format: "png", width: 4000, height: 3000, pages };
    },
    async encodeWebp(_bytes, req) {
      // size model: bigger width + higher quality → bigger output.
      const size = req.maxWidth * req.quality;
      return {
        bytes: new Uint8Array(size),
        width: req.maxWidth,
        height: Math.round((req.maxWidth * 3) / 4),
      };
    },
  };
}

function alwaysHugeEngine(): ImageEngine {
  return {
    async probe() {
      return { format: "png", width: 4000, height: 3000, pages: 1 };
    },
    async encodeWebp(_b, req) {
      return { bytes: new Uint8Array(50_000_000), width: req.maxWidth, height: 10 };
    },
  };
}

const sourceBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function makeTransformer(over: {
  engine?: ImageEngine;
  cached?: ProviderDerivativeRecord | null;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  db?: ReturnType<typeof fakeStorage>;
  workspaceId?: string;
  creativeId?: string;
}) {
  const db = over.db ?? fakeStorage();
  const fetchBytes =
    over.fetchBytes ?? vi.fn(async () => sourceBytes);
  const t = createImageDerivativeTransformer({
    workspaceId: over.workspaceId ?? "ws-1",
    sourceUrl: "https://cdn.example.com/original.png",
    originalCreativeId: over.creativeId ?? "cr-1",
    db,
    cachedDerivative: over.cached ?? null,
    engine: over.engine ?? laddderEngine(),
    fetchBytes,
  });
  return { t, db, fetchBytes };
}

// ---- canPrepareImage ------------------------------------------------

describe("canPrepareImage", () => {
  it("accepts still images, rejects gif", () => {
    const { t } = makeTransformer({});
    const base = { platform: "bluesky" as const, sizeBytes: 5_000_000, maxBytes: 1_900_000 };
    expect(t.canPrepareImage({ ...base, mimeType: "image/jpeg" })).toBe(true);
    expect(t.canPrepareImage({ ...base, mimeType: "image/png" })).toBe(true);
    expect(t.canPrepareImage({ ...base, mimeType: "image/webp" })).toBe(true);
    expect(t.canPrepareImage({ ...base, mimeType: "image/gif" })).toBe(false);
  });
});

// ---- generation -----------------------------------------------------

describe("prepareImage — generation", () => {
  it("steps down the ladder to fit under target, uploads, returns descriptor", async () => {
    const { t, db } = makeTransformer({});
    const d = await t.prepareImage({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 5_000_000,
      maxBytes: 1_900_000,
      originalCreativeId: "cr-1",
    });
    expect(d.sizeBytes).toBeLessThanOrEqual(1_900_000);
    expect(d.mimeType).toBe("image/webp");
    expect(d.publicUrl).toContain("https://cdn.example.com/");
    expect(d.transform?.targetBytes).toBe(1_900_000);
    // one upload, to the deterministic workspace-scoped derivative path
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0].path).toMatch(
      /^ws-1\/derivatives\/bluesky\/cr-1\/[0-9a-f]+\.webp$/,
    );
    expect(db.uploads[0].contentType).toBe("image/webp");
  });

  it("is deterministic — same source + target yields the same storage path", async () => {
    const a = makeTransformer({});
    const b = makeTransformer({});
    const d1 = await a.t.prepareImage({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 5_000_000,
      maxBytes: 1_900_000,
      originalCreativeId: "cr-1",
    });
    const d2 = await b.t.prepareImage({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 5_000_000,
      maxBytes: 1_900_000,
      originalCreativeId: "cr-1",
    });
    expect(d1.storageRef).toBe(d2.storageRef);
  });

  it("respects the X target (different ceiling)", async () => {
    const { t } = makeTransformer({});
    const d = await t.prepareImage({
      platform: "x",
      mimeType: "image/png",
      sizeBytes: 9_000_000,
      maxBytes: 5_000_000,
      originalCreativeId: "cr-1",
    });
    expect(d.sizeBytes).toBeLessThanOrEqual(5_000_000);
    expect(d.transform?.targetBytes).toBe(5_000_000);
  });

  it("throws when it cannot compress under target at the smallest preset", async () => {
    const { t } = makeTransformer({ engine: alwaysHugeEngine() });
    await expect(
      t.prepareImage({
        platform: "bluesky",
        mimeType: "image/jpeg",
        sizeBytes: 80_000_000,
        maxBytes: 1_900_000,
        originalCreativeId: "cr-1",
      }),
    ).rejects.toThrow(/could not compress/i);
  });

  it("throws on an animated source (multi-page)", async () => {
    const { t } = makeTransformer({ engine: laddderEngine(3) });
    await expect(
      t.prepareImage({
        platform: "bluesky",
        mimeType: "image/webp",
        sizeBytes: 5_000_000,
        maxBytes: 1_900_000,
        originalCreativeId: "cr-1",
      }),
    ).rejects.toThrow(/animated/i);
  });

  it("propagates a storage upload error as a DerivativeError", async () => {
    const { t } = makeTransformer({ db: fakeStorage({ uploadError: "boom" }) });
    await expect(
      t.prepareImage({
        platform: "bluesky",
        mimeType: "image/jpeg",
        sizeBytes: 5_000_000,
        maxBytes: 1_900_000,
        originalCreativeId: "cr-1",
      }),
    ).rejects.toThrow(/failed to store the derivative/i);
  });
});

// ---- dedup ----------------------------------------------------------

describe("prepareImage — dedup / reuse", () => {
  it("reuses a valid cached derivative without fetching or encoding", async () => {
    const cached: ProviderDerivativeRecord = {
      storage_path: "ws-1/derivatives/bluesky/cr-1/cached.webp",
      public_url: "https://cdn.example.com/cached.webp",
      mime_type: "image/webp",
      size_bytes: 1_500_000,
      width: 1600,
      height: 900,
      generated_at: "2026-06-01T00:00:00.000Z",
      source_size_bytes: 5_000_000,
      transform: {
        output_format: "image/webp",
        quality: 72,
        max_width: 1600,
        max_height: null,
        target_bytes: 1_900_000,
      },
    };
    const { t, db, fetchBytes } = makeTransformer({ cached });
    const d = await t.prepareImage({
      platform: "bluesky",
      mimeType: "image/jpeg",
      sizeBytes: 5_000_000,
      maxBytes: 1_900_000,
      originalCreativeId: "cr-1",
    });
    expect(d.storageRef).toBe("ws-1/derivatives/bluesky/cr-1/cached.webp");
    expect(d.publicUrl).toBe("https://cdn.example.com/cached.webp");
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(db.uploads).toHaveLength(0);
  });

  it("does NOT reuse a stale cache (source size changed)", () => {
    const cached: ProviderDerivativeRecord = {
      storage_path: "p",
      public_url: "u",
      mime_type: "image/webp",
      size_bytes: 1_000_000,
      width: null,
      height: null,
      generated_at: "x",
      source_size_bytes: 4_000_000, // original was different size
      transform: {
        output_format: "image/webp",
        quality: 72,
        max_width: 1600,
        max_height: null,
        target_bytes: 1_900_000,
      },
    };
    expect(isCachedDerivativeValid(cached, 5_000_000, 1_900_000)).toBe(false);
    expect(isCachedDerivativeValid(cached, 4_000_000, 1_900_000)).toBe(true);
  });
});

// ---- preparedToRecord round-trip -----------------------------------

describe("preparedToRecord", () => {
  it("maps the in-memory descriptor to the JSONB record shape", () => {
    const rec = preparedToRecord({
      platform: "bluesky",
      originalCreativeId: "cr-1",
      mimeType: "image/webp",
      sizeBytes: 1_500_000,
      width: 1600,
      height: 900,
      storageRef: "ws-1/derivatives/bluesky/cr-1/h.webp",
      publicUrl: "https://cdn/h.webp",
      sourceSizeBytes: 5_000_000,
      transform: {
        outputFormat: "image/webp",
        quality: 72,
        maxWidth: 1600,
        maxHeight: null,
        targetBytes: 1_900_000,
      },
      generatedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(rec.storage_path).toBe("ws-1/derivatives/bluesky/cr-1/h.webp");
    expect(rec.public_url).toBe("https://cdn/h.webp");
    expect(rec.size_bytes).toBe(1_500_000);
    expect(rec.source_size_bytes).toBe(5_000_000);
    expect(rec.transform.target_bytes).toBe(1_900_000);
    expect(rec.transform.output_format).toBe("image/webp");
  });
});

// ---- REAL sharp end-to-end -----------------------------------------

describe("prepareImage — real sharp engine (end-to-end)", () => {
  it("actually compresses an oversized PNG under the Bluesky 1.9MB target", async () => {
    const sharp = (await import("sharp")).default;
    // Build a genuinely large (~12MB) noisy PNG so it must be shrunk.
    const w = 2000,
      h = 2000;
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    const bigPng = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toBuffer();
    expect(bigPng.length).toBeGreaterThan(1_900_000);

    const db = fakeStorage();
    const t = createImageDerivativeTransformer({
      workspaceId: "ws-1",
      sourceUrl: "https://cdn.example.com/original.png",
      originalCreativeId: "cr-real",
      db,
      // omit `engine` → real sharp
      fetchBytes: async () => new Uint8Array(bigPng),
    });

    const d = await t.prepareImage({
      platform: "bluesky",
      mimeType: "image/png",
      sizeBytes: bigPng.length,
      maxBytes: 1_900_000,
      originalCreativeId: "cr-real",
    });

    expect(d.mimeType).toBe("image/webp");
    expect(d.sizeBytes).toBeLessThanOrEqual(1_900_000);
    expect(d.width).not.toBeNull();
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0].bytes).toBe(d.sizeBytes);
  }, 20_000);
});
