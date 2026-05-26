/**
 * Phase F6.0 — platform-native adapter contract.
 *
 * Every platform-native adapter lives under
 *   src/core/platform-native/adapters/<platform>/
 *
 * and exports a `PlatformNativeAdapter` from its index.ts.
 *
 * Isolation rules (load-bearing)
 * ------------------------------
 *   - Adapters MUST NOT import from another platform's adapter folder.
 *   - Adapters MAY import their own platform-specific code in
 *     src/core/publishing/<platform-files> and
 *     src/core/platform-preview/<platform>-preview.ts.
 *   - Adapters MAY import the shared core (publishing-intent,
 *     payload-hash, platform-capabilities, this file).
 *   - Stub adapters MUST NOT import any platform-specific module —
 *     they exist purely to satisfy the boundary so future per-platform
 *     PRs land in isolation.
 */

import type { PublishPlatform } from "@/core/publishing/publishing-types";
import type {
  PlatformNativeShape,
  ProviderPayloadBlocker,
  ProviderPayloadPreview,
} from "../publishing-intent";
import type { PlatformCapabilities } from "../platform-capabilities";

// =====================================================================
// Adapter input shapes — neutral, no provider-specific fields
// =====================================================================

export interface AdapterIdentity {
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

export interface AdapterCreative {
  /** Direct fetchable URL (CDN / Supabase storage). */
  assetUrl: string | null;
  /** Fallback URL for manual-url creatives. */
  sourceUrl: string | null;
  /** Alt text. */
  altText: string | null;
  /** "image" | "video" | … — passthrough; adapter decides what to do. */
  creativeType: string;
}

/**
 * Input to buildPreview and buildPublishPayload. Adapters that need
 * platform-specific fields must read them from the source row before
 * constructing this input — the shared shape stays neutral.
 */
export interface AdapterRenderInput {
  /** Plan-item title (may be ignored by the adapter). */
  title: string | null;
  /** Raw body (markdown allowed; adapters strip per provider rules). */
  body: string;
  /** Operator's identity for headers / permalinks. */
  identity: AdapterIdentity;
  /** Optional creative. */
  creative: AdapterCreative | null;
  /** The operator's platform-native shape. */
  shape: PlatformNativeShape;
  /**
   * Platform-specific routing target (Reddit: subreddit; LinkedIn:
   * company URN; Telegram: chat / channel id). Adapters that don't
   * need it ignore. Caller may always pass `null`.
   */
  target?: string | null;
  /**
   * Outbound URL for link-post / link-share intents. Adapters that
   * don't model link posts ignore.
   */
  linkUrl?: string | null;
  /**
   * Optional array of tags. Used by article platforms (dev.to,
   * Hashnode) and some social platforms (YouTube tags). Adapters
   * that don't model tags ignore.
   */
  tags?: ReadonlyArray<string>;
}

// =====================================================================
// Adapter contract
// =====================================================================

export interface PlatformNativeAdapter {
  platform: PublishPlatform;
  capabilities: PlatformCapabilities;
  /**
   * Render a deterministic preview. MUST be pure (no I/O) and MUST
   * return the same ProviderPayloadPreview shape that
   * buildPublishPayload would produce — preview ↔ publish parity is
   * the canonical invariant of this layer.
   *
   * Stub adapters return a preview with format="unknown" and at
   * least one blocker { code: "adapter_not_implemented", ... }.
   */
  buildPreview(input: AdapterRenderInput): ProviderPayloadPreview;
  /**
   * Build the payload the publisher will write. Returns the SAME
   * shape as buildPreview by design (so the hash binds across both
   * surfaces). Adapters that share their preview module with the
   * publisher delegate to it; stub adapters MUST NOT call any
   * provider-side code.
   */
  buildPublishPayload(input: AdapterRenderInput): ProviderPayloadPreview;
  /**
   * Validate a shape independently of any specific render. Used by
   * MCP write paths and the UI before computing a preview.
   */
  validateShape(shape: PlatformNativeShape): ProviderPayloadBlocker[];
}
