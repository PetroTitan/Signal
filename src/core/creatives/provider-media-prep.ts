/**
 * Provider-aware creative media preparation + preflight validation.
 *
 * Problem
 * -------
 * A creative can be perfectly valid inside Signal (we accept images up
 * to 10 MB, video up to 100 MB; the storage bucket caps at 100 MB) yet
 * be REJECTED by a target platform with stricter rules. The production
 * failure that motivated this layer:
 *
 *   Bluesky: "Invalid app.bsky.feed.post record: blob too big.
 *             maximum 2000000, got 2070497"
 *
 * The original creative was fine for Signal but 70 KB over Bluesky's
 * 2 MB per-blob limit. The fix is NOT to lower Signal's global limits
 * (that would degrade every other platform) — it is to inspect the
 * creative against the TARGET platform's limits and decide, per
 * platform, whether the original can be used, a provider-safe
 * derivative is needed, or the publish must be blocked so the operator
 * can replace the creative.
 *
 * Architecture principle
 * ----------------------
 *   - The ORIGINAL creative is never mutated.
 *   - Each platform may receive a provider-safe derivative.
 *   - This module is the single source of truth for "is this creative
 *     OK for platform X, and if not, what do we do about it?"
 *
 * Current capability (no image library installed)
 * -----------------------------------------------
 * Signal has NO image/video processing dependency (no sharp / jimp /
 * ffmpeg). Generating a smaller derivative requires re-encoding, which
 * needs such a library. Until one is approved, this layer implements
 * **preflight validation + blocking**: oversized / unsupported media
 * is BLOCKED before the provider API is called (so the operator gets a
 * clear, actionable reason instead of an opaque platform 4xx), and the
 * derivative path is fully architected behind an injectable
 * {@link MediaTransformer} so derivative generation can be turned on
 * later with no call-site changes. See `provider-media-derivatives.md`
 * thinking in the PR for the storage model.
 *
 * Pure module — no I/O, no Supabase, no `server-only`. The optional
 * transformer is injected by the caller; the default path is pure.
 */

import type { PublishPlatform, PublishReasonCode } from "@/core/publishing/publishing-types";

// =====================================================================
// Provider media policy map
// =====================================================================

export interface ProviderMediaPolicy {
  platform: PublishPlatform;
  /**
   * Does Signal upload raw image BYTES to this provider (so OUR
   * pre-upload size matters), or does the provider fetch the image
   * itself from a public URL (so the provider enforces its own limit
   * and we pass the URL through unchanged)?
   *
   *   - bluesky: uploadBlob — we upload bytes.            → true
   *   - x:       /2/media/upload — we upload bytes.       → true
   *   - telegram: sendPhoto(photo=URL) — Telegram fetches → false
   *   - devto/hashnode: cover_image URL — provider fetches→ false
   */
  uploadsImageBytes: boolean;
  /**
   * The byte ceiling Signal applies before uploading an image to this
   * provider. A SAFETY MARGIN below the provider's documented hard
   * limit (encoding overhead / multipart framing can push the wire
   * size slightly above the file size). null = no enforced ceiling
   * (either the provider fetches by URL, or no hard limit is known).
   */
  maxImageBytes: number | null;
  /** The provider's documented hard limit, for operator messaging. */
  hardImageBytes: number | null;
  /** Image MIME types this provider accepts (empty = inherit Signal's). */
  imageMimeTypes: readonly string[];
  /** Does THIS adapter currently publish images at all? */
  imagePublishSupported: boolean;
  /** Does THIS adapter currently publish video at all? */
  videoPublishSupported: boolean;
  /** Future-platform constraints / TODOs (not enforced today). */
  notes?: string;
}

const BLUESKY_HARD_IMAGE_BYTES = 2_000_000; // app.bsky.embed.images blob hard cap
const BLUESKY_SAFE_IMAGE_BYTES = 1_900_000; // 1.9 MB safety margin (spec)
const X_HARD_IMAGE_BYTES = 5_242_880; // 5 MB (X v2 /2/media/upload image)
const X_SAFE_IMAGE_BYTES = 5_000_000; // ~4.77 MB safety margin

const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

/**
 * Per-platform media policy. Limits map discovered/implemented during
 * the audit (see the PR completion report). Platforms that publish
 * manually (instagram, threads, youtube) or via link only (reddit) or
 * that fetch media by URL (telegram, devto, hashnode) carry their
 * constraints here for documentation + future enforcement, but only
 * the byte-uploading platforms (bluesky, x) enforce a ceiling today.
 */
export const PROVIDER_MEDIA_POLICY: Record<PublishPlatform, ProviderMediaPolicy> = {
  bluesky: {
    platform: "bluesky",
    uploadsImageBytes: true,
    maxImageBytes: BLUESKY_SAFE_IMAGE_BYTES,
    hardImageBytes: BLUESKY_HARD_IMAGE_BYTES,
    imageMimeTypes: IMAGE_MIME,
    imagePublishSupported: true,
    videoPublishSupported: false,
    notes:
      "uploadBlob hard cap is 2,000,000 bytes per image. Video embeds (app.bsky.embed.video) are not wired in the adapter yet.",
  },
  x: {
    platform: "x",
    uploadsImageBytes: true,
    maxImageBytes: X_SAFE_IMAGE_BYTES,
    hardImageBytes: X_HARD_IMAGE_BYTES,
    imageMimeTypes: IMAGE_MIME,
    imagePublishSupported: true,
    videoPublishSupported: false,
    notes:
      "v2 /2/media/upload single-image path. Video (chunked upload + processing poll) is not wired in the adapter yet.",
  },
  telegram: {
    platform: "telegram",
    // Telegram fetches the photo from the URL we pass to sendPhoto, so
    // OUR pre-upload size does not gate the publish — Telegram enforces
    // its own ~5 MB-by-URL limit server-side. We pass through unchanged.
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: 5_000_000,
    imageMimeTypes: IMAGE_MIME,
    imagePublishSupported: true,
    videoPublishSupported: false,
    notes: "sendPhoto(photo=public URL). Telegram fetches + validates server-side.",
  },
  devto: {
    platform: "devto",
    // cover_image is a URL in the article front-matter; dev.to fetches it.
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: null,
    imageMimeTypes: IMAGE_MIME,
    imagePublishSupported: true,
    videoPublishSupported: false,
    notes: "cover_image URL referenced in the article; dev.to fetches it.",
  },
  hashnode: {
    platform: "hashnode",
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: null,
    imageMimeTypes: IMAGE_MIME,
    imagePublishSupported: true,
    videoPublishSupported: false,
    notes: "coverImageOptions.coverImageURL referenced in the post; Hashnode fetches it.",
  },
  reddit: {
    platform: "reddit",
    // The Reddit adapter publishes text / link posts; it does not push
    // creative bytes through Signal's media pipeline.
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: null,
    imageMimeTypes: IMAGE_MIME,
    imagePublishSupported: false,
    videoPublishSupported: false,
    notes: "Text/link posts only via the current adapter. No media pipeline.",
  },
  linkedin: {
    platform: "linkedin",
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: null,
    imageMimeTypes: IMAGE_MIME,
    imagePublishSupported: false,
    videoPublishSupported: false,
    notes: "Publisher is a stub today. TODO: image is ~5 MB (assets register-upload).",
  },
  // --- Manual-distribution platforms: not auto-published yet. ---------
  // Architecture is prepared so derivatives can be added when these get
  // real publishing adapters. TODO constraints recorded for that work.
  instagram: {
    platform: "instagram",
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: 8_000_000,
    imageMimeTypes: ["image/jpeg"],
    imagePublishSupported: false,
    videoPublishSupported: false,
    notes:
      "TODO (manual today): JPEG only; ~8 MB image; aspect ratio 4:5–1.91:1; Reels/video need separate transcode + container flow.",
  },
  threads: {
    platform: "threads",
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: 8_000_000,
    imageMimeTypes: ["image/jpeg", "image/png"],
    imagePublishSupported: false,
    videoPublishSupported: false,
    notes:
      "TODO (manual today): JPEG/PNG; ~8 MB image; video up to ~1 GB / 5 min via the container API — needs a separate prep path.",
  },
  youtube: {
    platform: "youtube",
    uploadsImageBytes: false,
    maxImageBytes: null,
    hardImageBytes: null,
    imageMimeTypes: [],
    imagePublishSupported: false,
    videoPublishSupported: false,
    notes: "TODO (manual today): video-first platform; resumable upload + processing required.",
  },
};

// =====================================================================
// Result shapes
// =====================================================================

export type MediaPreparationStatus = "ready" | "derivative" | "blocked";

export type MediaKind = "image" | "animation" | "video" | "unknown";

/**
 * Descriptor for a generated provider-safe derivative. Returned only
 * when `status === "derivative"` (requires an injected transformer).
 * The shape is future-proof: video derivatives slot in with the same
 * fields once a transcoder is wired.
 */
export interface PreparedDerivative {
  platform: PublishPlatform;
  originalCreativeId: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** Where the derivative bytes live (storage path or data ref). */
  storageRef: string;
  generatedAt: string;
}

export interface ProviderMediaResult {
  status: MediaPreparationStatus;
  mediaKind: MediaKind;
  platform: PublishPlatform;
  /** Operator-facing reason code when `status === "blocked"`. */
  reasonCode: PublishReasonCode | null;
  /** Operator-facing detail when `status === "blocked"`. */
  reasonDetail: string | null;
  /** The byte ceiling applied (safety margin), null when none. */
  providerLimitBytes: number | null;
  /** Set only when `status === "derivative"`. */
  derivative: PreparedDerivative | null;
  /**
   * Flat, non-sensitive metadata bag to merge into
   * `PublishOutcome.metadata` (→ execution_logs). Keys align with the
   * completion-report contract:
   *   original_creative_id, media_kind, media_preparation_status,
   *   provider_media_limit_bytes, original_size_bytes, derivative_used,
   *   derivative_size_bytes.
   */
  metadata: Record<string, unknown>;
}

export interface PrepareProviderMediaInput {
  platform: PublishPlatform;
  /** Creative MIME type (from the creative row). null when unknown. */
  mimeType: string | null;
  /** Stored byte size (from the creative row). null when unknown. */
  sizeBytes: number | null;
  /** Creative row type ("image" | "video" | "animation"), used as a
   *  fallback when the MIME type is missing. */
  creativeType?: string | null;
  /** Creative row id, for audit metadata. */
  originalCreativeId?: string | null;
}

/**
 * Optional derivative generator. When supplied AND an image exceeds
 * the provider ceiling, the prep layer asks the transformer to produce
 * a provider-safe derivative instead of blocking. No transformer is
 * wired today (no image library), so the default path blocks.
 */
export interface MediaTransformer {
  /** True when this transformer can shrink the given source to fit. */
  canPrepareImage(input: {
    platform: PublishPlatform;
    mimeType: string;
    sizeBytes: number;
    maxBytes: number;
  }): boolean;
  /** Produce a provider-safe derivative. */
  prepareImage(input: {
    platform: PublishPlatform;
    mimeType: string;
    sizeBytes: number;
    maxBytes: number;
    originalCreativeId: string | null;
  }): Promise<PreparedDerivative>;
}

export interface PrepareProviderMediaOptions {
  transformer?: MediaTransformer;
}

// =====================================================================
// Helpers
// =====================================================================

export function getProviderMediaPolicy(
  platform: PublishPlatform,
): ProviderMediaPolicy {
  return PROVIDER_MEDIA_POLICY[platform];
}

/** The enforced image byte ceiling for a platform, or null. */
export function getProviderImageLimitBytes(
  platform: PublishPlatform,
): number | null {
  return PROVIDER_MEDIA_POLICY[platform].maxImageBytes;
}

export function classifyMediaKind(
  mimeType: string | null,
  creativeType?: string | null,
): MediaKind {
  const mime = mimeType?.toLowerCase() ?? "";
  if (mime === "image/gif") return "animation";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  // Fall back to the creative row type when MIME is absent.
  const t = creativeType?.toLowerCase() ?? "";
  if (t === "video") return "video";
  if (t === "animation") return "animation";
  if (t === "image") return "image";
  return "unknown";
}

function bytesToMb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function baseMetadata(
  input: PrepareProviderMediaInput,
  kind: MediaKind,
  status: MediaPreparationStatus,
  limit: number | null,
): Record<string, unknown> {
  return {
    original_creative_id: input.originalCreativeId ?? null,
    media_kind: kind,
    media_preparation_status: status,
    provider_media_limit_bytes: limit,
    original_size_bytes: input.sizeBytes ?? null,
    derivative_used: false,
    derivative_size_bytes: null,
  };
}

// =====================================================================
// prepareProviderMedia — the single decision entry point
// =====================================================================

/**
 * Decide how to handle a creative for a specific target platform.
 *
 * Returns one of:
 *   - `ready`      — the original creative is safe for this platform;
 *                    publish it unchanged.
 *   - `derivative` — a provider-safe derivative was produced (only when
 *                    a transformer is injected); publish the derivative.
 *   - `blocked`    — cannot prepare safely; the caller MUST NOT call the
 *                    provider publish API and MUST NOT silently publish
 *                    text-only. Surface `reasonCode` / `reasonDetail`.
 *
 * Pure unless `options.transformer` performs I/O.
 */
export async function prepareProviderMedia(
  input: PrepareProviderMediaInput,
  options: PrepareProviderMediaOptions = {},
): Promise<ProviderMediaResult> {
  const policy = PROVIDER_MEDIA_POLICY[input.platform];
  const kind = classifyMediaKind(input.mimeType, input.creativeType);

  const ready = (
    status: MediaPreparationStatus,
    extra?: Record<string, unknown>,
  ): ProviderMediaResult => ({
    status,
    mediaKind: kind,
    platform: input.platform,
    reasonCode: null,
    reasonDetail: null,
    providerLimitBytes: policy.maxImageBytes,
    derivative: null,
    metadata: { ...baseMetadata(input, kind, status, policy.maxImageBytes), ...extra },
  });

  const blocked = (
    reasonCode: PublishReasonCode,
    reasonDetail: string,
  ): ProviderMediaResult => ({
    status: "blocked",
    mediaKind: kind,
    platform: input.platform,
    reasonCode,
    reasonDetail,
    providerLimitBytes: policy.maxImageBytes,
    derivative: null,
    metadata: {
      ...baseMetadata(input, kind, "blocked", policy.maxImageBytes),
      media_blocked_reason: reasonCode,
    },
  });

  // --- Video: explicit preflight gate. No transcoding anywhere yet. ---
  if (kind === "video") {
    if (policy.videoPublishSupported) {
      // No platform reaches here today; future video adapters that
      // accept the original without transcoding land in `ready`.
      return ready("ready");
    }
    return blocked(
      "media_video_unsupported",
      `Video preparation is not supported yet for ${input.platform}. Attach an image, or publish the video manually on the platform.`,
    );
  }

  // --- Images / animations ---
  if (kind === "image" || kind === "animation") {
    if (!policy.imagePublishSupported) {
      return blocked(
        "media_not_supported_for_platform",
        `${input.platform} does not support automated image publishing yet. Remove the creative or publish manually.`,
      );
    }

    // MIME allow-list (only enforced when the policy names types AND
    // we actually know the MIME).
    if (
      input.mimeType &&
      policy.imageMimeTypes.length > 0 &&
      !policy.imageMimeTypes.includes(input.mimeType.toLowerCase())
    ) {
      return blocked(
        "media_format_unsupported_for_platform",
        `${input.mimeType} is not accepted by ${input.platform}. Supported: ${policy.imageMimeTypes.join(", ")}.`,
      );
    }

    // Provider fetches by URL (telegram / devto / hashnode): nothing for
    // us to size-check — pass the original through unchanged.
    if (!policy.uploadsImageBytes || policy.maxImageBytes === null) {
      return ready("ready");
    }

    // Byte-uploading provider (bluesky / x).
    if (input.sizeBytes === null) {
      // Size unknown (e.g. manual-URL creative we never measured). We
      // cannot block what we cannot measure; pass through and rely on
      // the publisher's in-flight byte guard to catch a true oversize
      // after the fetch, before the provider call.
      return ready("ready", { media_preparation_status: "ready" });
    }

    if (input.sizeBytes <= policy.maxImageBytes) {
      return ready("ready");
    }

    // Oversized. Try a derivative if a transformer is available;
    // otherwise block with a clear, actionable reason.
    const transformer = options.transformer;
    if (
      transformer &&
      input.mimeType &&
      transformer.canPrepareImage({
        platform: input.platform,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        maxBytes: policy.maxImageBytes,
      })
    ) {
      const derivative = await transformer.prepareImage({
        platform: input.platform,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        maxBytes: policy.maxImageBytes,
        originalCreativeId: input.originalCreativeId ?? null,
      });
      return {
        status: "derivative",
        mediaKind: kind,
        platform: input.platform,
        reasonCode: null,
        reasonDetail: null,
        providerLimitBytes: policy.maxImageBytes,
        derivative,
        metadata: {
          ...baseMetadata(input, kind, "derivative", policy.maxImageBytes),
          derivative_used: true,
          derivative_size_bytes: derivative.sizeBytes,
        },
      };
    }

    return blocked(
      "media_too_large_for_platform",
      `Image is ${bytesToMb(input.sizeBytes)}; ${input.platform}'s limit is ${bytesToMb(
        policy.maxImageBytes,
      )}` +
        (policy.hardImageBytes
          ? ` (hard cap ${bytesToMb(policy.hardImageBytes)})`
          : "") +
        ". Replace it with a smaller / more compressed image, then re-approve.",
    );
  }

  // --- Unknown media kind: be conservative but don't false-block when
  // there's no creative to speak of. An unknown MIME with a size that
  // a byte-uploading provider would reject is treated like an image
  // over the limit handled above; here we only reach unknown when MIME
  // is absent AND creativeType didn't classify. Pass through; the
  // publisher's own MIME guard will reject genuinely bad types. ---
  return ready("ready", { media_preparation_status: "ready" });
}

// =====================================================================
// Non-blocking approval / UI readiness messaging
// =====================================================================

export interface ProviderReadinessNote {
  /** True when the creative would NOT publish cleanly to this platform. */
  needsProviderSafeVersion: boolean;
  /** Operator-facing one-liner, or null when the creative is fine. */
  message: string | null;
}

/**
 * Advisory (NON-BLOCKING) provider-readiness check for the approval UI.
 *
 * Used to show "Creative is approved, but needs a platform-safe version
 * for Bluesky/X" without blocking approval for OTHER platforms. This
 * never changes approval policy — it only produces a message.
 */
export function describeProviderMediaReadiness(input: {
  platform: PublishPlatform;
  mimeType: string | null;
  sizeBytes: number | null;
  creativeType?: string | null;
}): ProviderReadinessNote {
  const policy = PROVIDER_MEDIA_POLICY[input.platform];
  const kind = classifyMediaKind(input.mimeType, input.creativeType);

  if (kind === "video" && !policy.videoPublishSupported) {
    return {
      needsProviderSafeVersion: true,
      message: `Video isn't supported for ${input.platform} yet — attach an image or publish the video manually.`,
    };
  }

  if ((kind === "image" || kind === "animation") && policy.uploadsImageBytes) {
    if (
      input.mimeType &&
      policy.imageMimeTypes.length > 0 &&
      !policy.imageMimeTypes.includes(input.mimeType.toLowerCase())
    ) {
      return {
        needsProviderSafeVersion: true,
        message: `Creative is approved, but ${input.mimeType} isn't accepted by ${input.platform}. Use ${policy.imageMimeTypes.join(", ")}.`,
      };
    }
    if (
      input.sizeBytes !== null &&
      policy.maxImageBytes !== null &&
      input.sizeBytes > policy.maxImageBytes
    ) {
      return {
        needsProviderSafeVersion: true,
        message: `Creative is approved, but needs a platform-safe version for ${input.platform} — it's ${bytesToMb(
          input.sizeBytes,
        )}, over the ${bytesToMb(policy.maxImageBytes)} limit.`,
      };
    }
  }

  return { needsProviderSafeVersion: false, message: null };
}
