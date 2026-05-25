/**
 * Platform-preview type contract.
 *
 * Inputs and outputs of the deterministic rendering layer. Strictly
 * content-shaped — no engagement metrics, no fake counts, no
 * timestamps, no avatars beyond what the operator's identity row
 * already stores.
 *
 * Pure module. No I/O. No network. No DOM.
 */

import type {
  CreativeDirection,
  PlatformNativeDraft,
  PlatformNativeFormat,
} from "@/core/platform-native";

export type PreviewPlatform = "bluesky" | "x" | "linkedin";

export interface PreviewIdentity {
  /** Display name shown in the post header. Null when unknown. */
  displayName: string | null;
  /** Handle (without @ for X, with .bsky.social for Bluesky, etc.). */
  handle: string | null;
  /** URL of the connected account's avatar — only the operator's own
   *  identity, never scraped or fabricated. Null when unknown. */
  avatarUrl: string | null;
}

export interface PreviewCreative {
  assetUrl: string | null;
  altText: string | null;
  /** Optional source type passthrough; renderers may flag certain
   *  combinations (e.g., a generated visual with no alt text). */
  sourceType: string | null;
}

export interface PreviewInput {
  platform: PreviewPlatform;
  /** Plan-item title — may be null on platforms that don't use one. */
  title: string | null;
  /** Plain text body, post-transformation (markdown stripped where
   *  appropriate by the renderer). */
  body: string;
  /** Operator's identity for the post header. */
  identity: PreviewIdentity;
  /** Creative for media affordances. */
  creative: PreviewCreative | null;
  /** Optional platform-native draft envelope from
   *  `adaptIdeaForPlatform`. When present, the renderer can lean on
   *  precomputed hook / cta / warnings / transformation-notes. */
  platformNativeDraft?: PlatformNativeDraft | null;
}

/** A single rendered part of the post. Threads produce multiple. */
export interface PreviewPart {
  /** 1-based index within the thread. Single posts are [1, 1]. */
  index: number;
  /** Total parts in the thread (>= 1). */
  total: number;
  /** Visible text in this part (truncation, URL shortening already
   *  applied — what the operator sees on the platform). */
  text: string;
  /** Number of graphemes (or chars where the platform uses chars). */
  length: number;
  /** Platform-specific length budget. */
  budget: number;
  /** True when the renderer had to truncate to fit `budget`. */
  truncated: boolean;
  /** Whether the creative renders attached to this specific part.
   *  Multi-part threads always attach to part 1 in this contract. */
  showsCreative: boolean;
}

/** Warning kinds the renderer can emit. Closed enum so the UI can
 *  render distinct affordances. */
export type PreviewWarningKind =
  | "likely_truncated"
  | "too_promotional"
  | "high_hashtag_density"
  | "external_link_heavy"
  | "corporate_tone"
  | "emoji_dense"
  | "alt_text_missing"
  | "thread_too_long"
  | "first_post_too_short"
  | "title_ignored_by_platform";

export interface PreviewWarning {
  kind: PreviewWarningKind;
  /** Operator-readable, calm. No alarmism. */
  message: string;
  /** Optional pointer to the offending part index (1-based). */
  partIndex?: number;
}

export type PreviewLengthUnit = "graphemes" | "chars";

export interface PreviewResult {
  platform: PreviewPlatform;
  /** Parts rendered for this post. At least one. */
  parts: ReadonlyArray<PreviewPart>;
  /** Identity to render in the post header. Identical to input. */
  identity: PreviewIdentity;
  /** Creative passthrough — UI uses this for the image card. */
  creative: PreviewCreative | null;
  /** Warnings + risk affordances. */
  warnings: ReadonlyArray<PreviewWarning>;
  /** Total length across all parts (post-transform). */
  totalLength: number;
  /** Per-part budget (e.g., 300 for Bluesky, 280 for X). */
  perPartBudget: number;
  /** Length unit the budget is measured in. */
  unit: PreviewLengthUnit;
  /** True when title is meaningful for this platform; false when
   *  the platform ignores titles (X, Bluesky, LinkedIn). */
  titleVisible: boolean;
  /** Format passthrough from PlatformNativeDraft when present, else
   *  derived from the renderer's output (single_post vs thread). */
  format: PlatformNativeFormat;
  /** Transformation notes — describes what the renderer changed
   *  (e.g., "Stripped markdown headings", "Split into 3 parts"). */
  transformationNotes: ReadonlyArray<string>;
  /** Creative direction passthrough when a PlatformNativeDraft is
   *  attached. Optional — the UI uses it to render a media hint. */
  creativeDirection?: CreativeDirection;
}
