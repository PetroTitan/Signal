/**
 * Identity-level connect dispatch.
 *
 * "Connect identity" is not the same thing across platforms:
 *
 *   - Reddit (and future X / LinkedIn with OAuth) — kick off the
 *     OAuth Authorization Code flow scoped to this identity. The
 *     callback verifies the authenticated handle against the
 *     identity's declared handle and refuses to mark connected on
 *     mismatch.
 *   - Bluesky / dev.to / Hashnode / Telegram — Signal already holds
 *     the workspace-level API credential. "Connecting" the identity
 *     means calling the platform's /me (or equivalent) to confirm
 *     the API credential resolves to the identity's declared
 *     handle, then storing a per-identity row in platform_
 *     connections. The actual provider clients land per-platform in
 *     follow-up PRs.
 *   - X / LinkedIn / YouTube / Threads / Instagram — distribution-
 *     only. There is nothing to connect; Signal opens the native
 *     composer and the operator publishes manually.
 *   - Indie Hackers — no API. Manual only.
 *   - Reserved for any future not_implemented platform.
 *
 * This module is the typed dispatcher between those branches. It is
 * pure and deterministic — the caller (`accounts/page.tsx`) computes
 * a `ConnectIdentityPlan` per identity and the UI renders whichever
 * action the plan describes.
 *
 * The plan does NOT execute. It describes the right endpoint to
 * call. The actual OAuth start route and API-key verify route are
 * the side-effecting paths.
 */

import type { FounderPlatform } from "./platform-guidance";

// =====================================================================
// Plan
// =====================================================================

/**
 * "Connect via the platform's OAuth flow." The UI renders a link to
 * `authorizeUrl`. The callback then handles handle verification
 * before marking the identity connected.
 */
export interface OAuthConnectPlan {
  kind: "oauth";
  platform: FounderPlatform;
  /** Pre-built Signal-side authorize URL (NOT the provider URL). */
  authorizeUrl: string;
  /** Operator-facing label for the button. */
  buttonLabel: string;
}

/**
 * "Verify via the workspace's API key + the identity's declared
 * handle." The UI hits `verifyUrl` (POST) which calls the platform's
 * /me (or equivalent) and stores a per-identity connection row only
 * if the handle matches. As of this PR the route is a stub that
 * returns `not_implemented`; the actual verification adapters ship
 * per-platform.
 */
export interface ApiKeyVerifyConnectPlan {
  kind: "api_key_verify";
  platform: FounderPlatform;
  verifyUrl: string;
  /** Operator-facing label for the button. */
  buttonLabel: string;
  /**
   * Identity-scoped sign-out endpoint. Present for platforms whose
   * verify flow persists a row (Telegram). Absent for legacy stubs.
   */
  signOutUrl?: string;
  /**
   * Optional per-platform operator setup instructions, rendered
   * above the Verify button as a bullet list. Used by Telegram to
   * explain "add the bot as admin first."
   */
  setupInstructions?: ReadonlyArray<string>;
}

/**
 * "Connect via per-identity app-password authentication." Used by
 * Bluesky: the operator provides a Bluesky App Password (NOT their
 * main account password); Signal authenticates against the AT
 * Protocol session API; tokens are encrypted server-side and stored
 * on platform_connections. Only after a successful authenticated
 * session (and a verified DID/handle match) is the identity marked
 * connected.
 *
 * `resolveUrl` points at the existing public handle-resolution route
 * — purely informational, used by the UI to show "handle resolves"
 * before the operator submits credentials. The route does NOT write
 * a connection row.
 *
 * `connectUrl` accepts a POST body of `{ handle, app_password }` and
 * runs the ownership-proving flow.
 */
export interface AppPasswordConnectPlan {
  kind: "app_password";
  platform: FounderPlatform;
  resolveUrl: string;
  connectUrl: string;
  /**
   * Identity-scoped sign-out endpoint. Hitting this only affects
   * THIS identity's connection row; other identities on the same
   * platform are untouched.
   */
  signOutUrl: string;
  /** Operator-facing label for the connect button. */
  buttonLabel: string;
  /**
   * Operator-facing security note rendered next to the password
   * input. Same string lives in the policy so the UI doesn't have
   * to invent copy.
   */
  credentialNote: string;
}

/**
 * "Connect via per-identity personal API key." For platforms where
 * each identity has its own long-lived API key (NOT a workspace-
 * level shared key). Today: dev.to. Hashnode joins this list in a
 * follow-up PR.
 *
 * Single-secret credential model (no session JWT, no refresh —
 * the key IS the credential). The form takes one secret field. The
 * key is encrypted server-side with TOKEN_ENCRYPTION_KEY and stored
 * in platform_connections.access_token_encrypted exactly like
 * Bluesky's access JWT.
 *
 * Same identity-scoped guarantees as the app_password flow:
 *   - connectUrl and signOutUrl are per-identity
 *   - the route refuses platforms other than the expected one
 *   - the response carries only the public username + id, never the
 *     key
 */
export interface PersonalApiKeyConnectPlan {
  kind: "personal_api_key";
  platform: FounderPlatform;
  connectUrl: string;
  signOutUrl: string;
  /** Operator-facing label for the connect button. */
  buttonLabel: string;
  /** Operator-facing security note rendered next to the key input. */
  credentialNote: string;
  /**
   * Where the operator generates the API key on the provider side.
   * Rendered as a link inside the form.
   */
  generateUrl: string;
  /** Label for the generate link ("dev.to API settings"). */
  generateLabel: string;
  /** Field label for the secret input ("dev.to API key"). */
  secretFieldLabel: string;
}

/**
 * "Nothing to connect." Distribution-only and manual-only platforms.
 * The UI renders a steady-state hint instead of a button.
 */
export interface ManualConnectPlan {
  kind: "manual";
  platform: FounderPlatform;
  /** One-line hint to render in place of a Connect button. */
  hint: string;
  /**
   * Optional second paragraph for platforms whose manual mode is a
   * deliberate hold rather than a permanent stance. Today: Hashnode,
   * while we wait for verified Pro/API access. The UI renders this
   * below `hint` in a muted-italic style so the steady-state copy
   * still leads.
   */
  note?: string;
}

/**
 * "Platform has no publishing path in Signal at all." Don't render a
 * Connect button.
 */
export interface UnsupportedConnectPlan {
  kind: "unsupported";
  platform: FounderPlatform;
}

export type ConnectIdentityPlan =
  | OAuthConnectPlan
  | ApiKeyVerifyConnectPlan
  | AppPasswordConnectPlan
  | PersonalApiKeyConnectPlan
  | ManualConnectPlan
  | UnsupportedConnectPlan;

// =====================================================================
// Inputs
// =====================================================================

export interface ConnectIdentityInput {
  /** The identity row's id (growth_accounts.id). */
  identityId: string;
  /** The identity's platform. */
  platform: FounderPlatform;
  /**
   * Editorial publishing mode for the platform. Same enum the
   * platform-guidance file uses. Combined with `distributionOnly` to
   * decide between `manual` and OAuth/API paths.
   */
  publishingMode: "api" | "manual" | "not_implemented";
  /**
   * True for distribution-only platforms (X, LinkedIn, YouTube,
   * Threads, Instagram). Signal does NOT authenticate to publish on
   * these; the operator publishes on the platform itself.
   */
  distributionOnly?: boolean;
  /**
   * True when the platform uses a per-identity OAuth flow (Reddit
   * today; future X / LinkedIn). When true and publishingMode is
   * "manual" (Reddit's pre-API-approval state), we still produce an
   * OAuth plan — manual mode is a distribution policy, not an
   * absence of identity auth.
   */
  oauthAvailable: boolean;
  /**
   * Optional path the OAuth callback should redirect back to. The
   * start route passes this through to the state row.
   */
  redirectAfter?: string;
}

// =====================================================================
// Resolver
// =====================================================================

/**
 * Build the Signal-side authorize URL the operator clicks. The
 * actual provider URL is built by the start route from the
 * (workspace_id, identity_id, platform) tuple — this is just the
 * Signal-side path that kicks the flow off.
 */
function buildOAuthAuthorizeUrl(input: ConnectIdentityInput): string {
  const params = new URLSearchParams();
  params.set("account_id", input.identityId);
  if (input.redirectAfter) params.set("redirect_after", input.redirectAfter);
  return `/api/oauth/${input.platform}/start?${params.toString()}`;
}

/**
 * Build the Signal-side verify URL for API-key platforms. Calls the
 * stub route that lands in this PR; the actual verifier lands in a
 * follow-up.
 */
function buildVerifyUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/verify`;
}

/**
 * Build the public-handle-resolution URL used by the Bluesky
 * app_password flow as a pre-flight check. Same /verify endpoint;
 * Bluesky's branch is informational-only.
 */
function buildResolveUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/verify`;
}

/**
 * Build the Signal-side connect URL for Bluesky's app-password flow.
 */
function buildBlueskyConnectUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/bluesky/connect`;
}

function buildBlueskySignOutUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/bluesky/sign-out`;
}

function buildDevtoConnectUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/devto/connect`;
}

function buildDevtoSignOutUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/devto/sign-out`;
}

function buildHashnodeConnectUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/hashnode/connect`;
}

function buildHashnodeSignOutUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/hashnode/sign-out`;
}

function buildTelegramVerifyUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/telegram/verify`;
}

function buildTelegramSignOutUrl(input: ConnectIdentityInput): string {
  return `/api/identity/${encodeURIComponent(input.identityId)}/telegram/sign-out`;
}

/**
 * Platforms where Signal currently has a usable per-identity OAuth
 * flow. Today: Reddit only. Future flows (X, LinkedIn with their own
 * OAuth) flip to true here once the start/callback routes are
 * wired up for them.
 */
const OAUTH_PLATFORMS: ReadonlyArray<FounderPlatform> = ["reddit"];

/**
 * Platforms that authenticate identities through a per-identity app
 * password (NOT the operator's main account password). The session
 * is authenticated against the platform's session API; tokens are
 * encrypted server-side. Today: Bluesky.
 */
const APP_PASSWORD_PLATFORMS: ReadonlyArray<FounderPlatform> = ["bluesky"];

/**
 * Platforms that authenticate identities through a per-identity
 * personal API key (one key per account, NOT a workspace-level
 * shared key). The key is verified against the provider's "who am I"
 * endpoint and stored encrypted. Today: dev.to + Hashnode.
 */
const PERSONAL_API_KEY_PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "devto",
  "hashnode",
];

/**
 * Platforms that authenticate identities through a workspace-level
 * API credential + a per-identity verify step (e.g. a bot token +
 * per-channel registration). These produce `api_key_verify` plans.
 * Today: Telegram (Hashnode + dev.to moved out to personal_api_key
 * because each identity has its own key, not a workspace-shared
 * one).
 */
const API_KEY_VERIFY_PLATFORMS: ReadonlyArray<FounderPlatform> = [
  "telegram",
];

/**
 * Returns whether a platform is a known OAuth-capable platform. The
 * UI uses this to decide whether to surface a Reauthorize / Connect
 * button at all.
 */
export function isOAuthCapablePlatform(platform: FounderPlatform): boolean {
  return OAUTH_PLATFORMS.includes(platform);
}

/**
 * Returns whether a platform uses per-identity app-password auth.
 */
export function isAppPasswordPlatform(platform: FounderPlatform): boolean {
  return APP_PASSWORD_PLATFORMS.includes(platform);
}

/**
 * Returns whether a platform uses per-identity personal API key
 * auth (one key per account, encrypted server-side).
 */
export function isPersonalApiKeyPlatform(
  platform: FounderPlatform,
): boolean {
  return PERSONAL_API_KEY_PLATFORMS.includes(platform);
}

/**
 * Returns whether a platform uses workspace-level API credentials
 * with a per-identity verify step.
 */
export function isApiKeyVerifyPlatform(platform: FounderPlatform): boolean {
  return API_KEY_VERIFY_PLATFORMS.includes(platform);
}

/**
 * UI-side decision: should the identity card render a "Manage"
 * button next to the state pill?
 *
 * - `oauth` / `app_password` / `api_key_verify`: yes — there are
 *   real account-access actions to perform.
 * - `manual`: yes — the panel renders a steady explanation so the
 *   operator sees the same affordance on every card.
 * - `unsupported` or undefined plan: no — nothing to manage.
 *
 * Pure function so the wrapper component stays display-only.
 */
export function shouldShowManageButton(
  plan: ConnectIdentityPlan | undefined,
): boolean {
  if (!plan) return false;
  return (
    plan.kind === "oauth" ||
    plan.kind === "app_password" ||
    plan.kind === "personal_api_key" ||
    plan.kind === "api_key_verify" ||
    plan.kind === "manual"
  );
}

/**
 * Pure deterministic resolver. Picks the right Connect plan for an
 * identity based on platform capability + the platform's auth mode.
 *
 * Resolution order:
 *   1. Platform is `not_implemented` → unsupported.
 *   2. Platform is API-mode and supports per-identity OAuth → oauth.
 *   3. Platform is API-mode and uses workspace API-key + handle
 *      verify → api_key_verify.
 *   4. Platform is distribution-only OR manual-only OR API-mode
 *      without a recognised auth path → manual.
 */
export function resolveConnectIdentityPlan(
  input: ConnectIdentityInput,
): ConnectIdentityPlan {
  const { platform } = input;

  if (input.publishingMode === "not_implemented") {
    return { kind: "unsupported", platform };
  }

  // Per-identity OAuth platforms (today: Reddit).
  if (input.oauthAvailable && isOAuthCapablePlatform(platform)) {
    return {
      kind: "oauth",
      platform,
      authorizeUrl: buildOAuthAuthorizeUrl(input),
      buttonLabel: "Sign in to this account",
    };
  }

  // Per-identity app-password platforms (today: Bluesky). Each
  // identity needs its own app password; resolving the public
  // handle is informational only and does not sign Signal in.
  if (input.publishingMode === "api" && isAppPasswordPlatform(platform)) {
    return {
      kind: "app_password",
      platform,
      resolveUrl: buildResolveUrl(input),
      connectUrl: buildBlueskyConnectUrl(input),
      signOutUrl: buildBlueskySignOutUrl(input),
      buttonLabel: "Sign in with Bluesky App Password",
      credentialNote:
        "Use a Bluesky App Password for this exact account, not your main password. " +
        "Create one at bsky.app/settings/app-passwords.",
    };
  }

  // Per-identity personal-API-key platforms. Each identity has its
  // own API key. Per-platform config (URLs, button labels, generate
  // link) lives in the branch so the operator copy is platform-
  // specific.
  if (
    input.publishingMode === "api" &&
    isPersonalApiKeyPlatform(platform)
  ) {
    if (platform === "devto") {
      return {
        kind: "personal_api_key",
        platform,
        connectUrl: buildDevtoConnectUrl(input),
        signOutUrl: buildDevtoSignOutUrl(input),
        buttonLabel: "Sign in",
        credentialNote:
          "To let Signal publish as this dev.to account, create a dev.to API key and paste it here. Signal uses it only for this identity.",
        generateUrl: "https://dev.to/settings/extensions",
        generateLabel: "dev.to → Settings → Extensions → DEV API Keys",
        secretFieldLabel: "dev.to API key",
      };
    }
    if (platform === "hashnode") {
      return {
        kind: "personal_api_key",
        platform,
        connectUrl: buildHashnodeConnectUrl(input),
        signOutUrl: buildHashnodeSignOutUrl(input),
        buttonLabel: "Sign in",
        credentialNote:
          "To let Signal publish as this Hashnode account, create a Hashnode API key and paste it here. Signal uses it only for this identity.",
        generateUrl: "https://hashnode.com/settings/developer",
        generateLabel: "Hashnode → Settings → Developer → Generate Token",
        secretFieldLabel: "Hashnode API key",
      };
    }
  }

  // Workspace-credential platforms with per-identity verify (today:
  // Telegram). The workspace owns one bot token; each identity
  // represents a specific channel the bot publishes to. Verification
  // confirms (a) the channel exists and (b) the bot has admin access
  // with permission to post.
  if (
    input.publishingMode === "api" &&
    isApiKeyVerifyPlatform(platform)
  ) {
    if (platform === "telegram") {
      return {
        kind: "api_key_verify",
        platform,
        verifyUrl: buildTelegramVerifyUrl(input),
        signOutUrl: buildTelegramSignOutUrl(input),
        buttonLabel: "Verify Telegram channel access",
        setupInstructions: [
          "Telegram uses the workspace bot.",
          "Add the bot as an admin to the channel first.",
          "This identity should use the channel username, e.g. @webmasterid.",
        ],
      };
    }
    // Fallback for any future api_key_verify platforms that haven't
    // been implemented yet — uses the legacy stub /verify route.
    return {
      kind: "api_key_verify",
      platform,
      verifyUrl: buildVerifyUrl(input),
      buttonLabel: "Sign in to this account",
    };
  }

  // Distribution-only or manual-only — nothing to authenticate.
  return {
    kind: "manual",
    platform,
    hint: input.distributionOnly
      ? "Manual distribution — Signal opens the native composer and you publish on the platform itself."
      : "Manual publish — Signal prepares the post; you publish on the platform.",
  };
}
