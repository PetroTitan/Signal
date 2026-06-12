import "server-only";
/**
 * Phase 2 — sharp-backed image derivative generator.
 *
 * Implements the `MediaTransformer` interface from provider-media-prep:
 * when an approved still image is too large for a target platform, this
 * fetches the ORIGINAL bytes, downscales / re-encodes them to fit under
 * the provider's safety ceiling, stores the result as a SEPARATE object
 * (the original is never touched), and returns a descriptor the
 * publisher uses to upload the provider-safe bytes.
 *
 * Runtime: Node.js only (sharp is a native addon). All Signal publish
 * paths run in the Node runtime — there is no Edge runtime anywhere in
 * the app — so this is safe on Vercel serverless functions.
 *
 * Scope: still images (JPEG/PNG/WebP). Animated GIFs are NOT optimized
 * (the prep layer blocks oversized GIFs before reaching here). Video is
 * out of scope.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchWithTimeout, isTimeoutError } from "@/core/publishing/fetch-with-timeout";
import type { PublishPlatform } from "@/core/publishing/publishing-types";
import type {
  DerivativeTransform,
  MediaTransformer,
  PreparedDerivative,
} from "./provider-media-prep";

/** Bucket that holds creatives + their derivatives (public-read). */
export const CREATIVES_BUCKET = "weekly-plan-creatives";

/**
 * Persisted descriptor shape stored under
 * `weekly_plan_item_creatives.metadata.provider_derivatives[platform]`.
 * snake_case to match the JSONB column convention.
 */
export interface ProviderDerivativeRecord {
  storage_path: string;
  public_url: string | null;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  generated_at: string;
  source_size_bytes: number | null;
  transform: {
    output_format: string;
    quality: number | null;
    max_width: number | null;
    max_height: number | null;
    target_bytes: number;
  };
}

/**
 * Thrown when a derivative cannot be produced. The prep layer catches
 * any transformer error and converts it to a `media_derivative_failed`
 * block (no text-only downgrade).
 */
export class DerivativeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DerivativeError";
  }
}

export interface ImageDerivativeDeps {
  workspaceId: string;
  /** Public URL of the ORIGINAL creative to downscale. */
  sourceUrl: string;
  originalCreativeId: string;
  /** Supabase client — service-role in the scheduler tick, cookie-aware
   *  in manual publish. Used only for storage upload + public URL. */
  db: SupabaseClient;
  /** Previously-stored descriptor for THIS platform (for dedup/reuse). */
  cachedDerivative?: ProviderDerivativeRecord | null;
  /** Injectable image engine (defaults to sharp) — lets tests run
   *  without the native addon. */
  engine?: ImageEngine;
  /** Injectable fetch for the original bytes (defaults to the shared
   *  timeout fetch). Tests pass a stub. */
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

// =====================================================================
// Pluggable image engine (sharp by default)
// =====================================================================

export interface ImageEngineProbe {
  format: string | null;
  width: number | null;
  height: number | null;
  /** > 1 for animated images (animated GIF/WebP). */
  pages: number;
}

export interface ImageEncodeRequest {
  /** Cap the longest edge to this width; never enlarges. */
  maxWidth: number;
  /** WebP/JPEG quality (1-100). */
  quality: number;
}

export interface ImageEngine {
  probe(bytes: Uint8Array): Promise<ImageEngineProbe>;
  /** Re-encode to WebP at the given width/quality. Returns the bytes +
   *  the resulting dimensions. */
  encodeWebp(
    bytes: Uint8Array,
    req: ImageEncodeRequest,
  ): Promise<{ bytes: Uint8Array; width: number | null; height: number | null }>;
}

/** Default engine backed by sharp. Imported lazily so the native addon
 *  only loads in the Node publish path, never at module eval time. */
function createSharpEngine(): ImageEngine {
  return {
    async probe(bytes) {
      const sharp = (await import("sharp")).default;
      const m = await sharp(bytes).metadata();
      return {
        format: m.format ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        pages: m.pages ?? 1,
      };
    },
    async encodeWebp(bytes, req) {
      const sharp = (await import("sharp")).default;
      const pipeline = sharp(bytes)
        .rotate() // honor EXIF orientation before resizing
        .resize({ width: req.maxWidth, withoutEnlargement: true })
        .webp({ quality: req.quality });
      const out = await pipeline.toBuffer({ resolveWithObject: true });
      return {
        bytes: out.data,
        width: out.info.width ?? null,
        height: out.info.height ?? null,
      };
    },
  };
}

// =====================================================================
// Encode strategy
// =====================================================================

/**
 * Progressive quality/width ladder. We start large + high quality and
 * step down only as needed to land under the target. Deterministic:
 * the same (original bytes, target) always yields the same output.
 */
const WIDTH_LADDER = [2048, 1600, 1280, 1024, 800] as const;
const QUALITY_LADDER = [82, 72, 62, 50, 40] as const;
const OUTPUT_MIME = "image/webp";
const OUTPUT_EXT = "webp";

/** Bytes are hashed to make the storage path deterministic + dedupe. */
function sha256Hex(...parts: (string | Uint8Array)[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/** Map a stored descriptor back to the in-memory PreparedDerivative. */
function recordToPrepared(
  platform: PublishPlatform,
  originalCreativeId: string,
  rec: ProviderDerivativeRecord,
): PreparedDerivative {
  return {
    platform,
    originalCreativeId,
    mimeType: rec.mime_type,
    sizeBytes: rec.size_bytes,
    width: rec.width,
    height: rec.height,
    storageRef: rec.storage_path,
    publicUrl: rec.public_url,
    sourceSizeBytes: rec.source_size_bytes,
    transform: {
      outputFormat: rec.transform.output_format,
      quality: rec.transform.quality,
      maxWidth: rec.transform.max_width,
      maxHeight: rec.transform.max_height,
      targetBytes: rec.transform.target_bytes,
    },
    generatedAt: rec.generated_at,
  };
}

/**
 * Is a cached descriptor still valid for the current request?
 * Valid when it was produced from the same source size, fits under the
 * current target, and targeted the same ceiling.
 */
export function isCachedDerivativeValid(
  rec: ProviderDerivativeRecord | null | undefined,
  sourceSizeBytes: number,
  maxBytes: number,
): rec is ProviderDerivativeRecord {
  return (
    !!rec &&
    rec.source_size_bytes === sourceSizeBytes &&
    rec.size_bytes <= maxBytes &&
    rec.transform.target_bytes === maxBytes &&
    typeof rec.storage_path === "string" &&
    rec.storage_path.length > 0
  );
}

export function createImageDerivativeTransformer(
  deps: ImageDerivativeDeps,
): MediaTransformer {
  const engine = deps.engine ?? createSharpEngine();
  const fetchBytes =
    deps.fetchBytes ??
    (async (url: string) => {
      let resp: Response;
      try {
        resp = await fetchWithTimeout(url, { method: "GET", timeoutMs: 20_000 });
      } catch (err) {
        if (isTimeoutError(err)) {
          throw new DerivativeError("fetching the original image timed out (20s)");
        }
        throw new DerivativeError(
          `network error fetching the original image: ${err instanceof Error ? err.message : "unknown"}`,
        );
      }
      if (!resp.ok) {
        throw new DerivativeError(
          `original image fetch returned ${resp.status}`,
        );
      }
      const ab = await resp.arrayBuffer();
      if (ab.byteLength === 0) {
        throw new DerivativeError("original image fetch returned empty body");
      }
      return new Uint8Array(ab);
    });

  return {
    canPrepareImage({ mimeType }) {
      // Still images only. Animated GIFs are blocked upstream; we never
      // attempt to "optimize" them by dropping frames.
      const m = mimeType.toLowerCase();
      return m === "image/jpeg" || m === "image/png" || m === "image/webp";
    },

    async prepareImage({ platform, sizeBytes, maxBytes, originalCreativeId }) {
      const creativeId = originalCreativeId ?? deps.originalCreativeId;

      // 1. Reuse a still-valid cached derivative (no fetch / no encode).
      if (isCachedDerivativeValid(deps.cachedDerivative, sizeBytes, maxBytes)) {
        return recordToPrepared(platform, creativeId, deps.cachedDerivative);
      }

      // 2. Fetch the ORIGINAL bytes (the original is never mutated).
      const original = await fetchBytes(deps.sourceUrl);

      // 3. Refuse animated sources defensively (prep should have blocked
      //    GIFs already, but a multi-page WebP must not be flattened).
      const probe = await engine.probe(original);
      if (probe.pages > 1) {
        throw new DerivativeError(
          "source is animated; animated image optimization is not supported",
        );
      }

      // 4. Step down the width/quality ladder until we fit under target.
      let chosen: {
        bytes: Uint8Array;
        width: number | null;
        height: number | null;
        transform: DerivativeTransform;
      } | null = null;
      const startWidth = probe.width ?? WIDTH_LADDER[0];
      for (const width of WIDTH_LADDER) {
        // Never upscale: skip ladder rungs wider than the source.
        const targetWidth = Math.min(width, startWidth);
        for (const quality of QUALITY_LADDER) {
          const out = await engine.encodeWebp(original, {
            maxWidth: targetWidth,
            quality,
          });
          if (out.bytes.byteLength <= maxBytes) {
            chosen = {
              bytes: out.bytes,
              width: out.width,
              height: out.height,
              transform: {
                outputFormat: OUTPUT_MIME,
                quality,
                maxWidth: targetWidth,
                maxHeight: null,
                targetBytes: maxBytes,
              },
            };
            break;
          }
        }
        if (chosen) break;
      }

      if (!chosen) {
        throw new DerivativeError(
          `could not compress under ${maxBytes} bytes even at the smallest preset`,
        );
      }

      // 5. Deterministic storage path: workspace-scoped (RLS requires
      //    the first path segment to be the workspace id), then
      //    derivatives/{platform}/{creativeId}/{hash}.{ext}. The hash
      //    binds original content + platform + transform settings so the
      //    same input always lands on the same object (idempotent).
      const contentHash = sha256Hex(
        original,
        platform,
        JSON.stringify(chosen.transform),
      ).slice(0, 32);
      const objectName = `${deps.workspaceId}/derivatives/${platform}/${creativeId}/${contentHash}.${OUTPUT_EXT}`;

      // 6. Upload the derivative (NEVER overwrites the original — this is
      //    a separate object). upsert keeps it idempotent for the
      //    deterministic path.
      const { error: uploadError } = await deps.db.storage
        .from(CREATIVES_BUCKET)
        .upload(objectName, Buffer.from(chosen.bytes), {
          contentType: OUTPUT_MIME,
          cacheControl: "31536000",
          upsert: true,
        });
      if (uploadError) {
        throw new DerivativeError(
          `failed to store the derivative: ${uploadError.message}`,
        );
      }

      const { data: pub } = deps.db.storage
        .from(CREATIVES_BUCKET)
        .getPublicUrl(objectName);

      return {
        platform,
        originalCreativeId: creativeId,
        mimeType: OUTPUT_MIME,
        sizeBytes: chosen.bytes.byteLength,
        width: chosen.width,
        height: chosen.height,
        storageRef: objectName,
        publicUrl: pub?.publicUrl ?? null,
        sourceSizeBytes: sizeBytes,
        transform: chosen.transform,
        generatedAt: new Date().toISOString(),
      };
    },
  };
}

/** Convert a PreparedDerivative into the JSONB-persisted record shape. */
export function preparedToRecord(d: PreparedDerivative): ProviderDerivativeRecord {
  return {
    storage_path: d.storageRef,
    public_url: d.publicUrl ?? null,
    mime_type: d.mimeType,
    size_bytes: d.sizeBytes,
    width: d.width,
    height: d.height,
    generated_at: d.generatedAt,
    source_size_bytes: d.sourceSizeBytes ?? null,
    transform: {
      output_format: d.transform?.outputFormat ?? OUTPUT_MIME,
      quality: d.transform?.quality ?? null,
      max_width: d.transform?.maxWidth ?? null,
      max_height: d.transform?.maxHeight ?? null,
      target_bytes: d.transform?.targetBytes ?? 0,
    },
  };
}
