/**
 * Phase F4.4 + F5.0 — platform guidance for founder publishing
 * identities.
 *
 * Pure data. No AI prompting, no automation. These are short
 * editorial hints rendered next to a platform choice so the founder
 * knows what kind of voice fits each platform.
 *
 * Platforms exposed in the founder UI:
 *   - reddit         (manual-first via Reddit's official OAuth + manual fallback)
 *   - devto          (automated when DEVTO_API_KEY is set)
 *   - hashnode       (automated when HASHNODE_API_KEY is set)
 *   - bluesky        (automated when BLUESKY_APP_PASSWORD is set)
 *   - indie_hackers  (manual-only — no API)
 *   - x              (F5.0 — manual-first distribution; share-intent fallback)
 *   - linkedin       (F5.0 — manual-first distribution; share-intent fallback)
 *
 * X and LinkedIn ARE NOT autonomous publishing layers. They are
 * distribution layers: Signal prepares the post, formats it for the
 * platform, opens the official compose intent URL, and the founder
 * confirms + clicks publish on the platform itself. The founder then
 * pastes the resulting permalink back into Signal so the publish
 * history stays unified.
 */

export type FounderPlatform =
  | "reddit"
  | "devto"
  | "hashnode"
  | "bluesky"
  | "indie_hackers"
  | "x"
  | "linkedin"
  | "youtube"
  | "threads"
  | "instagram"
  | "telegram";

export interface FounderPlatformGuidance {
  label: string;
  /** Short chip text. */
  short: string;
  /** One-sentence editorial hint shown next to the platform choice. */
  voiceHint: string;
  /** Whether Signal can currently publish to this platform automatically. */
  publishingMode: "api" | "manual" | "not_implemented";
  /** True for distribution-only platforms (X, LinkedIn). Founder must
   *  confirm + publish on the platform itself. */
  distributionOnly?: boolean;
}

const GUIDANCE: Record<FounderPlatform, FounderPlatformGuidance> = {
  reddit: {
    label: "Reddit",
    short: "r/",
    voiceHint:
      "Community-native discussions and topic-specific posting. Read the subreddit first; write like you belong there.",
    // Reddit is automated. The OAuth flow (start/callback/disconnect/
    // health), the publisher (`publishToReddit`), and the scheduler
    // allowlist all support per-identity Reddit publishing. The old
    // `"manual"` value here was a leftover from the pre-API-approval
    // era and was making the /accounts identity pill render
    // "Manual publish" even when OAuth was fully wired, because
    // `resolveIdentityPublishState` short-circuits manual platforms
    // to the "manual" state regardless of connection.
    //
    // OAuth availability at runtime is a separate concern handled by
    // /accounts threading `workspace: { configured: <oauth env up
    // AND !redditOauthBlocked AND encryption-on> }` into the
    // resolver — so when the OAuth flow is unusable, identity state
    // falls through to `pending_auth` ("Not signed in") rather than
    // the misleading "Manual publish."
    publishingMode: "api",
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
    // Phase F8 — Hashnode is automated. The identity-scoped
    // orchestrator (PR #124) loads a per-identity encrypted API key
    // + a publication id from connection metadata, and the scheduler
    // allowlist routes Hashnode items through runPublish. Hashnode's
    // free GraphQL access remains gated for non-Pro accounts; the
    // publisher surfaces that case explicitly as
    // `hashnode_provider_unavailable` so the operator copy is
    // accurate. This flip back to "api" is what makes the /accounts
    // Manage panel expose the API-key sign-in form (instead of the
    // legacy "manual publish" hint).
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
  x: {
    label: "X",
    short: "X",
    voiceHint:
      "Threads work better than long posts. Short, specific, technical or operational. No hashtag spam, no engagement bait, max one external link per thread.",
    // Phase F9 — X is automated. The OAuth flow + identity-scoped
    // orchestrator + scheduler routing are in place; the publisher
    // posts single-post text and optional single-image creative
    // through the official v2 endpoints. Threads, replies, quotes,
    // and DMs are NOT implemented and remain manual fallbacks via
    // `recordManualDistributionAction` until a future PR.
    publishingMode: "api",
  },
  linkedin: {
    label: "LinkedIn",
    short: "in",
    voiceHint:
      "Calm founder reflection. Short paragraphs, real operational lessons. Avoid recruiter tone, inspiration bait, and \"I'm thrilled\" openers.",
    publishingMode: "manual",
    distributionOnly: true,
  },
  youtube: {
    label: "YouTube",
    short: "YT",
    voiceHint:
      "Calm title, useful description with chapters, no MrBeast-style clickbait. Tags help discoverability; hashtag spam doesn't.",
    publishingMode: "manual",
    distributionOnly: true,
  },
  threads: {
    label: "Threads",
    short: "Th",
    voiceHint:
      "Short, conversational, lightweight founder updates. Lower technical density than LinkedIn or dev.to.",
    publishingMode: "manual",
    distributionOnly: true,
  },
  instagram: {
    label: "Instagram",
    short: "ig",
    voiceHint:
      "Visual-first platform. Caption supports the image — keep it human and calm. No \"link in bio\" / \"grindset\" / hustle bait.",
    publishingMode: "manual",
    distributionOnly: true,
  },
  telegram: {
    label: "Telegram",
    short: "Tg",
    voiceHint:
      "Channel updates for founders. Plain text, calm, infrequent. Signal posts via the Bot API only when the channel is configured.",
    publishingMode: "api",
  },
};

export const FOUNDER_PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "reddit",
  "devto",
  "hashnode",
  "bluesky",
  "indie_hackers",
  "x",
  "linkedin",
  "youtube",
  "threads",
  "instagram",
  "telegram",
];

/**
 * Look up the founder-facing label, short text, and voice hint for
 * a platform slug. Returns null when the slug isn't a supported
 * founder platform.
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
    value === "indie_hackers" ||
    value === "x" ||
    value === "linkedin" ||
    value === "youtube" ||
    value === "threads" ||
    value === "instagram" ||
    value === "telegram"
  );
}

/**
 * Convenience: friendly label for any platform slug, including
 * non-founder values. Safe for historical activity / publish history
 * rendering.
 */
export function friendlyPlatformLabel(platform: string): string {
  if (isFounderPlatform(platform)) return GUIDANCE[platform].label;
  return platform;
}
