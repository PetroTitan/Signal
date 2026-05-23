/**
 * Phase F4.4 — platform guidance for founder publishing identities.
 *
 * Pure data. No AI prompting, no automation. These are short
 * editorial hints rendered next to a platform choice so the founder
 * knows what kind of voice fits each platform. Future MCP / Claude
 * generation can read the same hints via
 * `resolveIdentityPlatformGuidance()`.
 *
 * Platforms exposed in the founder UI:
 *   - reddit
 *   - devto
 *   - hashnode
 *   - bluesky
 *   - indie_hackers
 *
 * X and LinkedIn are intentionally absent — they don't have
 * functional publishers yet, so we don't expose them as identity
 * targets either.
 */

export type FounderPlatform =
  | "reddit"
  | "devto"
  | "hashnode"
  | "bluesky"
  | "indie_hackers";

export interface FounderPlatformGuidance {
  label: string;
  /** Short chip text. */
  short: string;
  /** One-sentence editorial hint shown next to the platform choice. */
  voiceHint: string;
  /** Whether Signal can currently publish to this platform automatically. */
  publishingMode: "api" | "manual" | "not_implemented";
}

const GUIDANCE: Record<FounderPlatform, FounderPlatformGuidance> = {
  reddit: {
    label: "Reddit",
    short: "r/",
    voiceHint:
      "Community-native discussions and topic-specific posting. Read the subreddit first; write like you belong there.",
    publishingMode: "manual",
  },
  devto: {
    label: "dev.to",
    short: "dev",
    voiceHint:
      "Long-form technical posts for developers and founders. Tags matter, canonical URL helps SEO.",
    publishingMode: "api",
  },
  hashnode: {
    label: "Hashnode",
    short: "Hn",
    voiceHint:
      "Technical publishing with stronger engineering audiences. Cover image and series help discoverability.",
    publishingMode: "api",
  },
  bluesky: {
    label: "Bluesky",
    short: "Bs",
    voiceHint:
      "Short-form conversational posts and threads. Sentences first, links second. Long posts split into a thread.",
    publishingMode: "api",
  },
  indie_hackers: {
    label: "Indie Hackers",
    short: "IH",
    voiceHint:
      "Founder stories, growth lessons, and build-in-public updates. Concrete numbers and honest tradeoffs land best.",
    publishingMode: "manual",
  },
};

export const FOUNDER_PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "reddit",
  "devto",
  "hashnode",
  "bluesky",
  "indie_hackers",
];

/**
 * Look up the founder-facing label, short text, and voice hint for
 * a platform slug. Returns null when the slug isn't a supported
 * founder platform (e.g. legacy "x" / "linkedin" rows still in the
 * database).
 */
export function resolveIdentityPlatformGuidance(
  platform: string,
): FounderPlatformGuidance | null {
  if (!isFounderPlatform(platform)) return null;
  return GUIDANCE[platform];
}

export function isFounderPlatform(value: string): value is FounderPlatform {
  return (
    value === "reddit" ||
    value === "devto" ||
    value === "hashnode" ||
    value === "bluesky" ||
    value === "indie_hackers"
  );
}

/**
 * Convenience: friendly label for any platform slug, including
 * legacy values that won't appear in the new UI. Used when rendering
 * historical activity / publish history that may reference X or
 * LinkedIn rows from before F4.4.
 */
export function friendlyPlatformLabel(platform: string): string {
  if (isFounderPlatform(platform)) return GUIDANCE[platform].label;
  switch (platform) {
    case "x":
      return "X";
    case "linkedin":
      return "LinkedIn";
    default:
      return platform;
  }
}
