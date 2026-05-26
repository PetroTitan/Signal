"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ConnectIdentityPlan } from "@/core/publishing/connect-identity";
import type { IdentityPublishState } from "@/core/publishing/identity-publish-state";
import { HashnodePublicationForm } from "@/components/publishing/hashnode-publication-form";

interface ConnectionControlsProps {
  /**
   * Widened from the legacy OAuth-only union ("reddit" | "x" |
   * "linkedin") to any founder platform, so the component can render
   * the api_key_verify and manual variants too. OAuth-only sub-paths
   * (disconnect, health check) are gated on plan.kind === "oauth"
   * inside the component.
   */
  platform: string;
  accountId: string;
  providerConfigured: boolean;
  encryptionConfigured: boolean;
  /** Phase F2.5 (manual fallback): true when REDDIT_OAUTH_STATUS=blocked_…
   *  hides the Connect button + shows the operator the manual flow. */
  redditOauthBlocked?: boolean;
  /**
   * Hashnode-specific: the publication id currently saved on this
   * identity's connection metadata. `null` when the operator hasn't
   * set it yet (this is what produces the `connected_incomplete`
   * state). Used to pre-fill the inline publication-id form inside
   * the Manage panel.
   */
  hashnodePublicationId?: string | null;
  connectionStatus:
    | "not_connected"
    | "connected"
    | "expired"
    | "revoked"
    | "error"
    | "disabled"
    | "reauthorization_required";
  healthStatus: "healthy" | "degraded" | "expired" | "revoked" | "unknown";
  hasAccessToken: boolean;
  lastCheckedAt: string | null;
  /**
   * The handle currently bound to this identity (from the
   * platform_connections row when signed in, or the operator's
   * declared handle when not). Used in the "Signed in as <handle>"
   * line in the Manage panel.
   */
  handle?: string | null;
  /**
   * Resolved identity publish state from
   * resolveIdentityPublishState(). Drives the sign-in button label
   * ("Sign in to this account" / "Sign in again" / "Sign in with
   * correct account").
   */
  publishState?: IdentityPublishState;
  /**
   * Resolved connect plan from resolveConnectIdentityPlan(). When
   * present, the component dispatches based on plan.kind instead of
   * hardcoding the Reddit OAuth path.
   */
  connectPlan?: ConnectIdentityPlan;
  /**
   * Handle-mismatch evidence pulled from
   * connection.metadata.handle_mismatch. Rendered as a banner when
   * publishState === "mismatched".
   */
  mismatchEvidence?: {
    declared: string | null;
    authenticated: string | null;
  } | null;
}

/**
 * Display-friendly platform name for the personal_api_key form
 * header. Backend keys (founder-platform slugs) stay as-is; only the
 * UI string is friendlier.
 */
function planPlatformLabel(platform: string): string {
  if (platform === "devto") return "dev.to";
  if (platform === "hashnode") return "Hashnode";
  if (platform === "telegram") return "Telegram";
  return platform;
}

/**
 * Pick the OAuth button label from the resolver's verdict. The
 * existing connection_status alone can't tell "expired" from
 * "mismatched", which need different labels.
 *
 * Labels speak to the operator about a specific account, not the
 * underlying OAuth API connection. The route + state-enum names
 * stay technical.
 */
function oauthButtonLabel(publishState: IdentityPublishState | undefined): string {
  switch (publishState) {
    case "connected":
      return "Sign in again";
    case "expired":
      return "Sign in again";
    case "mismatched":
      return "Sign in with correct account";
    default:
      return "Sign in to this account";
  }
}

export function ConnectionControls(props: ConnectionControlsProps) {
  const { platform, accountId, providerConfigured, encryptionConfigured } = props;
  const router = useRouter();
  const [busy, setBusy] = useState<"connect" | "disconnect" | "health" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // ── Rate-limiting state ─────────────────────────────────────────
  // All account-access actions are explicit-click only — there are
  // no useEffect-driven fetches, no setInterval polling, no
  // background reconnect loops. After a failed sign-in, the button
  // is disabled for FAILED_AUTH_COOLDOWN_MS so the operator can't
  // accidentally rapid-fire bad credentials at the provider (and
  // get the account temporarily locked there). Check-account-access
  // gets a shorter cooldown to discourage click-spam against AT
  // Protocol's public API.
  const FAILED_AUTH_COOLDOWN_MS = 30_000;
  const CHECK_ACCESS_COOLDOWN_MS = 5_000;
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const inCooldown = Date.now() < cooldownUntil;

  async function disconnect() {
    setBusy("disconnect");
    setMessage(null);
    try {
      const res = await fetch(`/api/oauth/${platform}/disconnect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? "Sign-out failed.");
      } else {
        setMessage("Signed out of this account.");
        // Re-fetch server props — same reason as the Bluesky path:
        // the OAuth disconnect leaves the panel rendering the
        // "Signed in as <handle>" + sign-out button until the page
        // navigates away.
        router.refresh();
        // The pill, "Signed in as <handle>" line, and signed-in
        // action buttons are all driven by server-rendered props
        // (publishState, handle, connectionStatus). Without a
        // refresh they'd stay rendered as if still signed in until
        // the next navigation, which leaves the operator looking at
        // stale state. router.refresh() re-runs the server component
        // with fresh data from platform_connections.
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setBusy("health");
    setMessage(null);
    try {
      const res = await fetch(`/api/oauth/${platform}/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        health?: string;
        handle?: string;
        refreshed?: boolean;
        code?: string;
        error?: string;
      };
      if (json.ok && json.health === "healthy") {
        setMessage(
          `Account access OK${json.handle ? ` — signed in as u/${json.handle}` : ""}${
            json.refreshed ? " (session refreshed)" : ""
          }.`,
        );
      } else if (json.health) {
        setMessage(
          `${json.health}${json.code ? ` (${json.code})` : ""}${
            json.error ? ` — ${json.error}` : ""
          }`,
        );
      } else {
        setMessage(json.error ?? "Account-access check failed.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function verifyApiKey(verifyUrl: string) {
    setBusy("connect");
    setMessage(null);
    try {
      const res = await fetch(verifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        code?: string;
        error?: string;
        message?: string;
        authenticated_handle?: string;
      };
      if (json.code === "bot_not_admin") {
        // Telegram-specific clear setup instruction. The route
        // already provides operator-facing copy; we surface it.
        setMessage(
          json.message ??
            "Add the Signal Telegram bot as an admin to this channel, then try again.",
        );
      } else if (json.code === "chat_not_found") {
        setMessage(
          json.message ??
            "The channel was not found or isn't accessible to the bot.",
        );
      } else if (json.code === "handle_mismatch") {
        setMessage(
          json.message ??
            "Verified a different account than this identity expects.",
        );
      } else if (!res.ok || json.ok === false) {
        setMessage(json.error ?? json.message ?? "Verification failed.");
      } else {
        const handle = json.authenticated_handle;
        setMessage(
          handle ? `Signed in as @${handle}.` : "Verification succeeded.",
        );
        router.refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  // App-password connect (Bluesky). Holds the form state in component
  // memory only; nothing is logged or persisted client-side beyond
  // the immediate fetch. On submit the password leaves the browser
  // exactly once.
  const [appPasswordFormOpen, setAppPasswordFormOpen] = useState(false);
  const [appPasswordHandle, setAppPasswordHandle] = useState("");
  const [appPasswordValue, setAppPasswordValue] = useState("");

  // Personal-API-key connect (dev.to today; Hashnode in phase 3).
  // Single-secret form: only the API key field is needed. The
  // secret leaves the browser exactly once on submit and is then
  // cleared from component state regardless of outcome.
  const [apiKeyFormOpen, setApiKeyFormOpen] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState("");

  async function submitPersonalApiKey(
    e: FormEvent<HTMLFormElement>,
    connectUrl: string,
  ) {
    e.preventDefault();
    if (inCooldown) return;
    setBusy("connect");
    setMessage(null);
    try {
      const res = await fetch(connectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKeyValue }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        code?: string;
        error?: string;
        message?: string;
        authenticated_handle?: string;
        declared?: string;
        authenticated?: string;
      };
      // Clear the key from component memory regardless of outcome.
      setApiKeyValue("");
      if (res.ok && json.ok) {
        setMessage(
          `Signed in as ${json.authenticated_handle ?? "this account"}.`,
        );
        setApiKeyFormOpen(false);
        router.refresh();
      } else if (json.code === "handle_mismatch") {
        // Show the actual usernames so the operator can decide
        // whether to grab a key for the right account or fix the
        // identity handle.
        const authenticated = json.authenticated ?? "another account";
        const declared = json.declared ?? props.handle ?? "this identity";
        setMessage(
          `Account mismatch — this key belongs to ${authenticated}, but this identity expects ${declared}.`,
        );
        setCooldownUntil(Date.now() + FAILED_AUTH_COOLDOWN_MS);
      } else if (json.code === "attached_to_another_identity") {
        // Strict per-identity invariant: the credential resolves to
        // an account already attached to a sibling identity in this
        // workspace. Surface the route's operator copy verbatim — it
        // already explains the next step (manage the existing
        // identity or sign out of it). No cooldown — there's nothing
        // for the operator to brute-force here.
        setMessage(
          json.message ??
            json.error ??
            "That credential is already attached to another identity in this workspace.",
        );
      } else if (json.code === "auth_failed") {
        setMessage("Sign-in failed. Check the API key and try again.");
        setCooldownUntil(Date.now() + FAILED_AUTH_COOLDOWN_MS);
      } else if (json.code === "api_unavailable") {
        // The provider refused to service the API request itself
        // (e.g. Hashnode retired free GraphQL access on 2026-05-13).
        // Surface the route's operator-friendly copy verbatim and
        // skip the cooldown — there's nothing for the operator to
        // fix by retrying with a different key.
        setMessage(
          json.message ??
            "This platform's API is not available right now. Try again later or switch to manual publish for this identity.",
        );
      } else {
        setMessage(json.error ?? json.message ?? "Sign-in failed.");
        setCooldownUntil(Date.now() + FAILED_AUTH_COOLDOWN_MS);
      }
    } finally {
      setBusy(null);
    }
  }

  async function signOutPersonalApiKey(signOutUrl: string) {
    setBusy("disconnect");
    setMessage(null);
    try {
      const res = await fetch(signOutUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (res.ok && json.ok) {
        setMessage("Signed out of this account.");
        router.refresh();
      } else {
        setMessage(json.error ?? json.message ?? "Sign-out failed.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function signOutBluesky(signOutUrl: string) {
    setBusy("disconnect");
    setMessage(null);
    try {
      const res = await fetch(signOutUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
      };
      if (res.ok && json.ok) {
        setMessage("Signed out of this account.");
      } else {
        setMessage(json.error ?? json.message ?? "Sign-out failed.");
      }
    } finally {
      setBusy(null);
    }
  }

  /**
   * Bluesky "Check account access" via the public-resolve route.
   * Resolves the declared handle and confirms it still maps to a
   * DID — a real round-trip sanity check that does NOT need the
   * App Password (the password isn't re-prompted). Does not write
   * a row; purely informational. Click-only; gated by a short
   * cooldown to discourage rapid spam against AT Protocol's
   * public API.
   */
  async function checkBlueskyAccess(resolveUrl: string) {
    if (inCooldown) return;
    setBusy("health");
    setMessage(null);
    try {
      const res = await fetch(resolveUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        code?: string;
        resolved_handle?: string;
        provider_account_id?: string;
        message?: string;
        error?: string;
      };
      if (res.ok && json.code === "handle_resolved") {
        setMessage(
          `Handle resolves to ${json.resolved_handle ?? "this account"}.`,
        );
      } else if (json.code === "handle_mismatch") {
        setMessage(
          json.message ??
            "Handle now resolves to a different account. Sign in again.",
        );
      } else {
        setMessage(json.error ?? json.message ?? "Account-access check failed.");
      }
      // Short cooldown after every Check, success or not, to keep
      // the action manual / low-frequency.
      setCooldownUntil(Date.now() + CHECK_ACCESS_COOLDOWN_MS);
    } finally {
      setBusy(null);
    }
  }

  async function submitAppPassword(
    e: FormEvent<HTMLFormElement>,
    connectUrl: string,
  ) {
    e.preventDefault();
    if (inCooldown) return;
    setBusy("connect");
    setMessage(null);
    try {
      const res = await fetch(connectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          handle: appPasswordHandle.trim(),
          app_password: appPasswordValue,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        code?: string;
        error?: string;
        message?: string;
        authenticated_handle?: string;
      };
      // Clear the password from component memory regardless of
      // outcome. We never re-use it.
      setAppPasswordValue("");
      if (res.ok && json.ok) {
        setMessage(
          `Signed in as ${json.authenticated_handle ?? "this account"}.`,
        );
        setAppPasswordFormOpen(false);
        // Re-run the server component so the pill and panel reflect
        // the new state. Without this, the page would still show
        // "Not signed in" + the sign-in form until navigation.
        router.refresh();
      } else if (json.code === "handle_mismatch") {
        // The App Password authenticated, but to a different Bluesky
        // account than this identity is bound to. Surface the
        // mismatch and cool down so the operator can't rapid-fire
        // bad attempts.
        setMessage(
          json.message ??
            "Signed in as a different Bluesky account than this identity expects.",
        );
        setCooldownUntil(Date.now() + FAILED_AUTH_COOLDOWN_MS);
      } else if (json.code === "attached_to_another_identity") {
        // Strict per-identity invariant — see the personal_api_key
        // branch above. Same copy-from-route pattern.
        setMessage(
          json.message ??
            json.error ??
            "That Bluesky session is already attached to another identity in this workspace.",
        );
      } else if (json.code === "auth_failed") {
        setMessage(
          "Bluesky rejected the credentials. Double-check the handle and App Password.",
        );
        // Cool down to prevent rapid retries that would let Bluesky
        // rate-limit (or lock) the account upstream.
        setCooldownUntil(Date.now() + FAILED_AUTH_COOLDOWN_MS);
      } else {
        setMessage(json.error ?? json.message ?? "Sign-in failed.");
        // Other failures (network, provider error, invalid input)
        // also cool down — same reason.
        setCooldownUntil(Date.now() + FAILED_AUTH_COOLDOWN_MS);
      }
    } finally {
      setBusy(null);
    }
  }

  const plan = props.connectPlan;
  const oauthLabel = oauthButtonLabel(props.publishState);
  const showMismatchBanner = props.publishState === "mismatched";

  return (
    <div className="text-[11px] text-ink-500 space-y-2">
      {/*
        The identity card already renders the publish-state pill +
        the formatted "Last checked" line. Don't duplicate them here
        or echo raw enum values — keep the panel focused on actions.
      */}
      {showMismatchBanner ? (
        <div className="text-[11px] rounded-md border border-red-200 bg-red-50 text-red-800 px-2.5 py-1.5 leading-relaxed">
          <div className="font-semibold">Account mismatch.</div>
          <div className="mt-0.5">
            Signed in as{" "}
            <span className="font-mono">
              {props.mismatchEvidence?.authenticated ?? "—"}
            </span>
            , expected{" "}
            <span className="font-mono">
              {props.mismatchEvidence?.declared ?? "—"}
            </span>
            . Sign in again with the correct account.
          </div>
        </div>
      ) : null}

      {props.redditOauthBlocked && platform === "reddit" ? (
        <div className="text-[10px] text-amber-700">
          Reddit is in manual publish mode while their API approval is
          pending. You&apos;ll copy and paste from the post preview.
        </div>
      ) : !providerConfigured && plan?.kind === "oauth" ? (
        <div className="text-[10px] text-amber-700">
          This platform isn&apos;t set up for connecting yet.
        </div>
      ) : !encryptionConfigured && plan?.kind === "oauth" ? (
        <div className="text-[10px] text-amber-700">
          Secure token storage isn&apos;t configured yet.
        </div>
      ) : null}

      <div className="flex gap-2 flex-wrap mt-1">
        {plan?.kind === "oauth" &&
        providerConfigured &&
        !(props.redditOauthBlocked && platform === "reddit") ? (
          <a href={plan.authorizeUrl} className="btn-primary text-[11px]">
            {oauthLabel}
          </a>
        ) : null}

        {/*
          api_key_verify is the workspace-credential + per-identity-
          verify shape (Telegram today). The UI is state-aware so
          operators get clear setup instructions when not yet
          verified, and a Sign out button after verification.
        */}
        {plan?.kind === "api_key_verify" &&
        plan.setupInstructions &&
        props.publishState !== "connected" ? (
          <ul className="basis-full text-[10px] text-ink-600 leading-relaxed list-disc pl-4 space-y-0.5">
            {plan.setupInstructions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}

        {plan?.kind === "api_key_verify" &&
        props.publishState === "connected" ? (
          <div className="basis-full space-y-2">
            <div className="text-[11px] text-ink-700">
              Signed in as{" "}
              <span className="font-mono">
                {props.handle
                  ? `@${(props.handle ?? "").replace(/^@/, "")}`
                  : "this channel"}
              </span>
              .
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => verifyApiKey(plan.verifyUrl)}
                disabled={busy !== null || inCooldown}
                className="btn-secondary text-[11px]"
              >
                {busy === "connect" ? "…" : "Check channel access"}
              </button>
              {plan.signOutUrl ? (
                <button
                  type="button"
                  onClick={() => signOutPersonalApiKey(plan.signOutUrl!)}
                  disabled={busy !== null}
                  className="btn-secondary text-[11px]"
                >
                  {busy === "disconnect" ? "…" : "Sign out of this account"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {plan?.kind === "api_key_verify" &&
        props.publishState === "mismatched" ? (
          <div className="basis-full space-y-2">
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => verifyApiKey(plan.verifyUrl)}
                disabled={busy !== null || inCooldown}
                className="btn-primary text-[11px]"
              >
                {busy === "connect" ? "…" : "Verify with correct channel"}
              </button>
              {plan.signOutUrl ? (
                <button
                  type="button"
                  onClick={() => signOutPersonalApiKey(plan.signOutUrl!)}
                  disabled={busy !== null}
                  className="btn-secondary text-[11px]"
                >
                  {busy === "disconnect" ? "…" : "Sign out of this account"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {plan?.kind === "api_key_verify" &&
        props.publishState !== "connected" &&
        props.publishState !== "mismatched" ? (
          <button
            type="button"
            onClick={() => verifyApiKey(plan.verifyUrl)}
            disabled={busy === "connect"}
            className="btn-primary text-[11px]"
          >
            {busy === "connect" ? "…" : plan.buttonLabel}
          </button>
        ) : null}

        {/*
          Bluesky app-password flow. The "Connect" button opens an
          inline form that takes the operator's handle + App Password.
          On submit the credentials are sent to /api/identity/:id/
          bluesky/connect which runs the AT Protocol createSession
          flow and only marks the identity connected after a
          handle/DID match.
        */}
        {/*
          Bluesky app_password compact views by state. All buttons
          are explicit-click only — no useEffect-driven fetches, no
          auto-retry. After a failed sign-in the form button is
          gated by the cooldown so the operator can't rapid-fire
          credentials at Bluesky.
        */}
        {plan?.kind === "app_password" &&
        !appPasswordFormOpen &&
        props.publishState === "connected" ? (
          <div className="basis-full space-y-2">
            <div className="text-[11px] text-ink-700">
              Signed in as{" "}
              <span className="font-mono">
                {props.handle ?? "this account"}
              </span>
              .
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => checkBlueskyAccess(plan.resolveUrl)}
                disabled={busy !== null || inCooldown}
                className="btn-secondary text-[11px]"
              >
                {busy === "health" ? "…" : "Check account access"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppPasswordFormOpen(true);
                  setMessage(null);
                }}
                disabled={busy !== null || inCooldown}
                className="btn-secondary text-[11px]"
              >
                Sign in again
              </button>
              <button
                type="button"
                onClick={() => signOutBluesky(plan.signOutUrl)}
                disabled={busy !== null}
                className="btn-secondary text-[11px]"
              >
                {busy === "disconnect" ? "…" : "Sign out of this account"}
              </button>
            </div>
          </div>
        ) : null}

        {plan?.kind === "app_password" &&
        !appPasswordFormOpen &&
        props.publishState === "mismatched" ? (
          <div className="basis-full space-y-2">
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setAppPasswordFormOpen(true);
                  setMessage(null);
                }}
                disabled={busy !== null || inCooldown}
                className="btn-primary text-[11px]"
              >
                Sign in with correct account
              </button>
              <button
                type="button"
                onClick={() => signOutBluesky(plan.signOutUrl)}
                disabled={busy !== null}
                className="btn-secondary text-[11px]"
              >
                {busy === "disconnect" ? "…" : "Sign out of this account"}
              </button>
            </div>
          </div>
        ) : null}

        {plan?.kind === "app_password" &&
        !appPasswordFormOpen &&
        props.publishState !== "connected" &&
        props.publishState !== "mismatched" ? (
          <>
            <button
              type="button"
              onClick={() => {
                setAppPasswordFormOpen(true);
                setMessage(null);
              }}
              disabled={busy !== null || inCooldown}
              className="btn-primary text-[11px]"
            >
              {plan.buttonLabel}
            </button>
            <p className="basis-full text-[10px] text-ink-500 leading-relaxed italic mt-1">
              This identity represents a specific Bluesky account.
              Resolving the public handle confirms it exists, but
              doesn&apos;t sign Signal in. Use a Bluesky App Password
              for this exact account to give Signal publishing
              access.
            </p>
          </>
        ) : null}

        {plan?.kind === "app_password" && inCooldown ? (
          <p className="basis-full text-[10px] text-amber-700 mt-1">
            Sign-in is briefly disabled after a failed attempt. Wait a
            moment before trying again.
          </p>
        ) : null}

        {plan?.kind === "app_password" && appPasswordFormOpen ? (
          <form
            onSubmit={(e) => submitAppPassword(e, plan.connectUrl)}
            className="basis-full mt-2 rounded-md border border-ink-200 bg-ink-50/30 p-3 space-y-2"
          >
            <div className="text-[11px] font-semibold text-ink-900">
              Sign in to this Bluesky account
            </div>
            <p className="text-[10px] text-amber-800 leading-relaxed">
              {plan.credentialNote}
            </p>
            <label className="block">
              <span className="text-[10px] font-medium text-ink-600">
                Bluesky handle
              </span>
              <input
                type="text"
                autoComplete="username"
                value={appPasswordHandle}
                onChange={(e) => setAppPasswordHandle(e.target.value)}
                placeholder="name.bsky.social"
                className="mt-1 w-full rounded border border-ink-200 px-2 py-1 text-[11px] font-mono"
                required
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-medium text-ink-600">
                Bluesky App Password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={appPasswordValue}
                onChange={(e) => setAppPasswordValue(e.target.value)}
                placeholder="xxxx-xxxx-xxxx-xxxx"
                className="mt-1 w-full rounded border border-ink-200 px-2 py-1 text-[11px] font-mono"
                required
              />
              <span className="mt-1 block text-[10px] text-ink-500">
                Generate one at{" "}
                <a
                  href="https://bsky.app/settings/app-passwords"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  bsky.app/settings/app-passwords
                </a>
                . Signal stores the resulting session encrypted and
                never the App Password itself.
              </span>
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy === "connect" || inCooldown}
                className="btn-primary text-[11px]"
              >
                {busy === "connect" ? "…" : "Sign in"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAppPasswordFormOpen(false);
                  setAppPasswordValue("");
                  setMessage(null);
                }}
                className="btn-secondary text-[11px]"
              >
                Cancel
              </button>
            </div>
            {inCooldown ? (
              <p className="text-[10px] text-amber-700 mt-1">
                Recent sign-in failed. Wait briefly before retrying.
              </p>
            ) : null}
          </form>
        ) : null}

        {/*
          Personal API key flow (dev.to + Hashnode today). Same
          four-state UI pattern as Bluesky: signed-out, signed-in,
          mismatch, form. The form is single-field (the secret); the
          handle is already on the identity row.

          For Hashnode, an additional inline form for the publication
          id renders under the signed-in summary. It is the second
          piece of required setup (the API key proves account
          ownership; the publication id picks which blog to publish
          to). The `connected_incomplete` state is what fires when
          the API key is saved but no publication id is set yet — we
          render this branch for BOTH `connected` and
          `connected_incomplete` so the operator can finish setup
          inline without leaving /accounts.
        */}
        {plan?.kind === "personal_api_key" &&
        !apiKeyFormOpen &&
        (props.publishState === "connected" ||
          props.publishState === "connected_incomplete") ? (
          <div className="basis-full space-y-2">
            <div className="text-[11px] text-ink-700">
              Signed in as{" "}
              <span className="font-mono">
                {props.handle ?? "this account"}
              </span>
              .
            </div>
            {plan.platform === "hashnode" ? (
              <div className="rounded-md border border-ink-100 bg-ink-50/40 px-3 py-2.5">
                {props.publishState === "connected_incomplete" ? (
                  <p className="text-[11px] text-amber-800 leading-relaxed mb-2">
                    API key is saved. Add the publication id Hashnode
                    publishes to in order to enable scheduled
                    publishing.
                  </p>
                ) : null}
                <HashnodePublicationForm
                  identityId={props.accountId}
                  identityHandle={props.handle ?? props.accountId}
                  initialPublicationId={props.hashnodePublicationId ?? null}
                  variant="compact"
                />
              </div>
            ) : null}
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setApiKeyFormOpen(true);
                  setMessage(null);
                }}
                disabled={busy !== null || inCooldown}
                className="btn-secondary text-[11px]"
              >
                Sign in again
              </button>
              <button
                type="button"
                onClick={() => signOutPersonalApiKey(plan.signOutUrl)}
                disabled={busy !== null}
                className="btn-secondary text-[11px]"
              >
                {busy === "disconnect" ? "…" : "Sign out of this account"}
              </button>
            </div>
          </div>
        ) : null}

        {plan?.kind === "personal_api_key" &&
        !apiKeyFormOpen &&
        props.publishState === "mismatched" ? (
          <div className="basis-full space-y-2">
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => {
                  setApiKeyFormOpen(true);
                  setMessage(null);
                }}
                disabled={busy !== null || inCooldown}
                className="btn-primary text-[11px]"
              >
                Sign in with correct account
              </button>
              <button
                type="button"
                onClick={() => signOutPersonalApiKey(plan.signOutUrl)}
                disabled={busy !== null}
                className="btn-secondary text-[11px]"
              >
                {busy === "disconnect" ? "…" : "Sign out of this account"}
              </button>
            </div>
          </div>
        ) : null}

        {plan?.kind === "personal_api_key" &&
        !apiKeyFormOpen &&
        props.publishState !== "connected" &&
        props.publishState !== "connected_incomplete" &&
        props.publishState !== "mismatched" ? (
          <>
            <button
              type="button"
              onClick={() => {
                setApiKeyFormOpen(true);
                setMessage(null);
              }}
              disabled={busy !== null || inCooldown}
              className="btn-primary text-[11px]"
            >
              {plan.buttonLabel}
            </button>
          </>
        ) : null}

        {plan?.kind === "personal_api_key" && inCooldown ? (
          <p className="basis-full text-[10px] text-amber-700 mt-1">
            Sign-in is briefly disabled after a failed attempt. Wait a
            moment before trying again.
          </p>
        ) : null}

        {plan?.kind === "personal_api_key" && apiKeyFormOpen ? (
          <form
            onSubmit={(e) => submitPersonalApiKey(e, plan.connectUrl)}
            className="basis-full mt-2 rounded-md border border-ink-200 bg-ink-50/30 p-3 space-y-2"
          >
            <div className="text-[11px] font-semibold text-ink-900">
              Sign in to this {planPlatformLabel(plan.platform)} account
            </div>
            {/*
              The credential note explains *why* an API key is the
              correct sign-in method here — operators expect a
              password-style flow on a publishing platform, so we
              spell out the per-identity scope and that the key
              isn't a developer setting.
            */}
            <p className="text-[10px] text-ink-600 leading-relaxed">
              {plan.credentialNote}
            </p>
            <label className="block">
              <span className="text-[10px] font-medium text-ink-600">
                {planPlatformLabel(plan.platform)} username
              </span>
              <input
                type="text"
                value={props.handle ?? ""}
                readOnly
                aria-readonly="true"
                tabIndex={-1}
                className="mt-1 w-full rounded border border-ink-200 bg-ink-100/40 px-2 py-1 text-[11px] font-mono text-ink-700 cursor-not-allowed"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-medium text-ink-600">
                {plan.secretFieldLabel}
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={apiKeyValue}
                onChange={(e) => setApiKeyValue(e.target.value)}
                className="mt-1 w-full rounded border border-ink-200 px-2 py-1 text-[11px] font-mono"
                required
              />
              <span className="mt-1 block text-[10px] text-ink-500">
                Create a {planPlatformLabel(plan.platform)} API key in{" "}
                <a
                  href={plan.generateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  {plan.generateLabel}
                </a>
                . Signal stores it encrypted and never exposes the key.
              </span>
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy === "connect" || inCooldown}
                className="btn-primary text-[11px]"
              >
                {busy === "connect" ? "…" : "Sign in"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setApiKeyFormOpen(false);
                  setApiKeyValue("");
                  setMessage(null);
                }}
                className="btn-secondary text-[11px]"
              >
                Cancel
              </button>
            </div>
            {inCooldown ? (
              <p className="text-[10px] text-amber-700 mt-1">
                Recent sign-in failed. Wait briefly before retrying.
              </p>
            ) : null}
          </form>
        ) : null}

        {plan?.kind === "oauth" &&
        (props.connectionStatus === "connected" ||
          props.connectionStatus === "expired" ||
          props.connectionStatus === "reauthorization_required" ||
          props.connectionStatus === "error") ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy === "disconnect"}
            className="btn-secondary text-[11px]"
          >
            {busy === "disconnect" ? "…" : "Sign out of this account"}
          </button>
        ) : null}

        {plan?.kind === "oauth" &&
        (props.hasAccessToken || props.connectionStatus !== "not_connected") ? (
          <button
            type="button"
            onClick={check}
            disabled={busy === "health"}
            className="btn-secondary text-[11px]"
          >
            {busy === "health" ? "…" : "Check account access"}
          </button>
        ) : null}
      </div>
      {message ? <div className="text-[10px] text-ink-600">{message}</div> : null}
    </div>
  );
}
