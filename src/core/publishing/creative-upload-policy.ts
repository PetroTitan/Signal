/**
 * Phase F2.5 — server-side upload validation rules.
 *
 * The MIME whitelist is hard-coded here. The bucket has the same
 * list, and the table has a CHECK constraint on the same list, but
 * we validate at every layer ("defence in depth"). Anything not
 * mentioned is refused; SVG / HTML / JS / EXE / ZIP / PDF have no
 * path into the system.
 */

import "server-only";

export const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
export const ALLOWED_VIDEO_MIME = ["video/mp4", "video/webm"] as const;

export const ALLOWED_MIME = [
  ...ALLOWED_IMAGE_MIME,
  ...ALLOWED_VIDEO_MIME,
] as const;

export type AllowedMime = (typeof ALLOWED_MIME)[number];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

export function mimeIsAllowed(mime: string | null | undefined): mime is AllowedMime {
  if (!mime) return false;
  return (ALLOWED_MIME as readonly string[]).includes(mime);
}

export function mimeIsVideo(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return (ALLOWED_VIDEO_MIME as readonly string[]).includes(mime);
}

export function maxBytesForMime(mime: AllowedMime): number {
  return mimeIsVideo(mime) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}

export function extensionForMime(mime: AllowedMime): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
  }
}

export function creativeTypeForMime(
  mime: AllowedMime,
): "image" | "video" | "animation" {
  if (mime === "image/gif") return "animation";
  if (mimeIsVideo(mime)) return "video";
  return "image";
}

export interface UploadValidationResult {
  ok: boolean;
  reason: string | null;
}

export function validateUpload(input: {
  mime: string | null;
  sizeBytes: number;
}): UploadValidationResult {
  if (!mimeIsAllowed(input.mime)) {
    return {
      ok: false,
      reason: `Mime type "${input.mime ?? "unknown"}" is not on the allow-list. Allowed: ${ALLOWED_MIME.join(", ")}.`,
    };
  }
  if (input.sizeBytes <= 0) {
    return { ok: false, reason: "Empty file." };
  }
  const cap = maxBytesForMime(input.mime);
  if (input.sizeBytes > cap) {
    const mb = (cap / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      reason: `File is ${(input.sizeBytes / (1024 * 1024)).toFixed(1)} MB; max ${mb} MB for ${input.mime}.`,
    };
  }
  return { ok: true, reason: null };
}
