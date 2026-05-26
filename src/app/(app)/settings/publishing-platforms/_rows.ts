/**
 * /settings/publishing-platforms — pure row resolver.
 *
 * Lives in a sibling module (not page.tsx) because Next.js App-Router
 * page files restrict the set of named exports. Tests import this
 * file directly to pin row logic without rendering the React tree.
 *
 * This module is workspace-level only: it answers "is the platform's
 * workspace integration plumbing in place?" Per-identity sign-in
 * state lives on /accounts and is resolved by
 * `resolveIdentityPublishState`.
 */

export interface PublishingPlatformsInputs {
  /** From readTierOneConfigStatus(). */
  tier1: {
    devto: { configured: boolean };
    hashnode: { configured: boolean; hasPublicationId: boolean };
    bluesky: { configured: boolean };
    telegram: { configured: boolean };
  };
  /** isOAuthProviderConfigured('reddit') — REDDIT_CLIENT_ID is set. */
  redditProviderConfigured: boolean;
  /** isRedditOauthBlocked() — REDDIT_OAUTH_STATUS=blocked_… */
  redditBlocked: boolean;
  /** hasTokenEncryptionKey() — TOKEN_ENCRYPTION_KEY is set. */
  encryptionOn: boolean;
}

export type PublishingPlatformRowStatus =
  | { kind: "ready"; detail: string }
  | { kind: "missing"; detail: string }
  | { kind: "manual"; detail: string };

export interface PublishingPlatformRow {
  /** Stable identifier used by tests and keyed list rendering. */
  key:
    | "reddit"
    | "devto"
    | "hashnode"
    | "bluesky"
    | "telegram";
  label: string;
  status: PublishingPlatformRowStatus;
}

/**
 * Build the rows array from environment + tier-1 config truth.
 *
 * Reddit-ready requires the full OAuth flow to be usable end-to-end:
 *   - provider env (REDDIT_CLIENT_ID) configured
 *   - token encryption (TOKEN_ENCRYPTION_KEY) configured
 *   - NOT in the manual-mode hold (!redditOauthBlocked)
 * Anything else short-circuits to either `manual` (operator blocked
 * at API approval) or `missing` (env not configured).
 *
 * Telegram-ready requires only that TELEGRAM_BOT_TOKEN is set — but
 * the detail copy spells out the per-channel admin requirement so
 * the row doesn't overclaim "fully ready channel publishing."
 */
export function buildPublishingPlatformRows(
  input: PublishingPlatformsInputs,
): PublishingPlatformRow[] {
  const {
    tier1,
    redditProviderConfigured,
    redditBlocked,
    encryptionOn,
  } = input;

  const rows: PublishingPlatformRow[] = [];

  // Reddit — OAuth
  if (redditBlocked) {
    rows.push({
      key: "reddit",
      label: "Reddit",
      status: {
        kind: "manual",
        detail:
          "Manual mode. Reddit's API approval is still pending — copy and paste from the post preview.",
      },
    });
  } else if (!redditProviderConfigured) {
    rows.push({
      key: "reddit",
      label: "Reddit",
      status: {
        kind: "missing",
        detail:
          "Configure REDDIT_CLIENT_ID in your environment to enable OAuth sign-in.",
      },
    });
  } else if (!encryptionOn) {
    rows.push({
      key: "reddit",
      label: "Reddit",
      status: {
        kind: "missing",
        detail:
          "Configure TOKEN_ENCRYPTION_KEY in your environment before connecting Reddit OAuth.",
      },
    });
  } else {
    rows.push({
      key: "reddit",
      label: "Reddit",
      status: { kind: "ready", detail: "Connected via OAuth." },
    });
  }

  // dev.to — workspace API key (env)
  rows.push({
    key: "devto",
    label: "dev.to",
    status: tier1.devto.configured
      ? { kind: "ready", detail: "Connected." }
      : {
          kind: "missing",
          detail:
            "Add a dev.to API key in your environment to publish here.",
        },
  });

  // Hashnode — workspace API key + publication id (env)
  if (tier1.hashnode.configured) {
    rows.push({
      key: "hashnode",
      label: "Hashnode",
      status: { kind: "ready", detail: "Connected." },
    });
  } else if (tier1.hashnode.hasPublicationId) {
    rows.push({
      key: "hashnode",
      label: "Hashnode",
      status: {
        kind: "missing",
        detail:
          "Publication is set, but the API key is missing. Add a Hashnode key in your environment.",
      },
    });
  } else {
    rows.push({
      key: "hashnode",
      label: "Hashnode",
      status: {
        kind: "missing",
        detail:
          "Add a Hashnode API key and select the publication to publish to.",
      },
    });
  }

  // Bluesky — workspace identifier + app password (env)
  rows.push({
    key: "bluesky",
    label: "Bluesky",
    status: tier1.bluesky.configured
      ? { kind: "ready", detail: "Connected." }
      : {
          kind: "missing",
          detail:
            "Add your Bluesky identifier and app-password in your environment.",
        },
  });

  // Telegram — workspace bot token (env). Per-channel admin is a
  // separate per-identity step the row copy must NOT hide.
  rows.push({
    key: "telegram",
    label: "Telegram",
    status: tier1.telegram.configured
      ? {
          kind: "ready",
          detail:
            "Bot token configured — add the bot as admin of each channel before scheduling.",
        }
      : {
          kind: "missing",
          detail:
            "Add a Telegram bot token (TELEGRAM_BOT_TOKEN) in your environment to publish here.",
        },
  });

  return rows;
}
