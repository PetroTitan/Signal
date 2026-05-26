/**
 * Phase F6.0 — adapter registry.
 *
 * The single place callers ask "give me the platform-native adapter
 * for X". The registry is the ONLY shared lookup table; per-platform
 * code stays inside each adapter folder.
 *
 * Adding or replacing an adapter
 * ------------------------------
 *   1. Write the adapter in src/core/platform-native/adapters/<name>/index.ts.
 *   2. Add it to ADAPTERS below, replacing the stub for that platform.
 *   3. Do NOT touch any other adapter folder — that's the isolation
 *      contract this whole layer exists to enforce.
 */

import type { PublishPlatform } from "@/core/publishing/publishing-types";
import { blueskyAdapter } from "./bluesky";
import { devtoAdapter } from "./devto";
import { hashnodeAdapter } from "./hashnode";
import { instagramAdapter } from "./instagram";
import { linkedinAdapter } from "./linkedin";
import { redditAdapter } from "./reddit";
import { telegramAdapter } from "./telegram";
import { threadsAdapter } from "./threads";
import { xAdapter } from "./x";
import { youtubeAdapter } from "./youtube";
import type { PlatformNativeAdapter } from "./types";

const ADAPTERS: Record<PublishPlatform, PlatformNativeAdapter> = {
  bluesky: blueskyAdapter,
  x: xAdapter,
  linkedin: linkedinAdapter,
  reddit: redditAdapter,
  devto: devtoAdapter,
  hashnode: hashnodeAdapter,
  threads: threadsAdapter,
  instagram: instagramAdapter,
  telegram: telegramAdapter,
  youtube: youtubeAdapter,
};

/**
 * Return the adapter for a platform. Every known platform has an
 * entry — stub adapters are still returned and clearly mark
 * themselves via `capabilities.stub`.
 *
 * Returns null for unknown platforms (e.g., a future PublishPlatform
 * value added to the union without an adapter wired up — caught by
 * the exhaustive Record type at compile time, but defended at runtime
 * too).
 */
export function getPlatformAdapter(
  platform: PublishPlatform,
): PlatformNativeAdapter | null {
  return ADAPTERS[platform] ?? null;
}

/**
 * Iterate all registered adapters. Used by surfaces that need to
 * render per-platform capability badges (e.g., the compose-modal
 * summary) without hardcoding the platform list.
 */
export function listPlatformAdapters(): ReadonlyArray<PlatformNativeAdapter> {
  return Object.values(ADAPTERS);
}
