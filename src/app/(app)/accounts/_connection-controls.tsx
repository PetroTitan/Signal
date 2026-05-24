"use client";

import { useState, type FormEvent } from "react";
import type { ConnectIdentityPlan } from "@/core/publishing/connect-identity";
import type { IdentityPublishState } from "@/core/publishing/identity-publish-state";

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
   * Resolved identity publish state from
   * resolveIdentityPublishState(). Drives whether the connect button
   * label is "Connect identity" / "Reauthorize" / "Reconnect with
   * correct account".
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

const STATUS_LABELS: Record<ConnectionControlsProps["connectionStatus"], string> = {
  not_connected: "Not connected",
  connected: "Connected",
  expired: "Token expired",
  revoked: "Revoked",
  error: "Error",
  disabled: "Disabled",
  reauthorization_required: "Reauthorization required",
};

/**
 * Pick the OAuth button label from the resolver's verdict. The
 * existing connection_status alone can't tell "expired" from
 * "mismatched", which need different labels.
 */
function oauthButtonLabel(publishState: IdentityPublishState | undefined): string {
  switch (publishState) {
    case "connected":
      return "Reauthorize";
    case "expired":
      return "Reconnect";
    case "mismatched":
      return "Reconnect with correct account";
    default:
      return "Connect identity";
  }
}

export function ConnectionControls(props: ConnectionControlsProps) {
  const { platform, accountId, providerConfigured, encryptionConfigured } = props;
  const [busy, setBusy] = useState<"connect" | "disconnect" | "health" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
        setMessage(json.error ?? "Disconnect failed.");
      } else {
        setMessage("Disconnected.");
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
          `Healthy${json.handle ? ` — connected as u/${json.handle}` : ""}${
            json.refreshed ? " (token refreshed)" : ""
          }.`,
        );
      } else if (json.health) {
        setMessage(
          `${json.health}${json.code ? ` (${json.code})` : ""}${
            json.error ? ` — ${json.error}` : ""
          }`,
        );
      } else {
        setMessage(json.error ?? "Health check failed.");
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
      };
      if (res.status === 501 || json.code === "not_implemented") {
        setMessage(
          json.message ??
            "Verification for this platform isn't wired up yet. A follow-up PR will add the provider client.",
        );
      } else if (!res.ok || json.ok === false) {
        setMessage(json.error ?? "Verification failed.");
      } else {
        // NOTE: this handler is wired only for the api_key_verify
        // plan kind (dev.to / Hashnode / Telegram). Bluesky uses the
        // separate app_password flow. The verbiage below is
        // deliberately not "Identity verified" — that would imply
        // ownership has been proven, which a workspace-level API-key
        // lookup does not establish on its own.
        setMessage(
          json.message ?? "Handle resolved via workspace credentials.",
        );
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

  async function submitAppPassword(
    e: FormEvent<HTMLFormElement>,
    connectUrl: string,
  ) {
    e.preventDefault();
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
          `Connected as ${json.authenticated_handle ?? "this account"}.`,
        );
        setAppPasswordFormOpen(false);
      } else if (json.code === "handle_mismatch") {
        setMessage(
          json.message ??
            "Credentials belong to a different Bluesky account.",
        );
      } else if (json.code === "auth_failed") {
        setMessage(
          "Bluesky rejected the credentials. Double-check the handle and App Password.",
        );
      } else {
        setMessage(json.error ?? json.message ?? "Connection failed.");
      }
    } finally {
      setBusy(null);
    }
  }

  const plan = props.connectPlan;
  const oauthLabel = oauthButtonLabel(props.publishState);
  const showMismatchBanner = props.publishState === "mismatched";

  return (
    <div className="text-[11px] text-ink-500 space-y-1">
      <div>
        <span className="badge-neutral text-[10px]">
          {STATUS_LABELS[props.connectionStatus]}
        </span>
        <span className="ml-2">health: {props.healthStatus}</span>
      </div>
      {props.lastCheckedAt ? (
        <div className="text-[10px] text-ink-400">
          Last checked {props.lastCheckedAt}
        </div>
      ) : null}

      {showMismatchBanner ? (
        <div className="text-[11px] rounded-md border border-red-200 bg-red-50 text-red-800 px-2.5 py-1.5 leading-relaxed">
          <div className="font-semibold">Connected account differs from identity.</div>
          <div className="mt-0.5">
            Expected{" "}
            <span className="font-mono">
              {props.mismatchEvidence?.declared ?? "—"}
            </span>
            ; authenticated as{" "}
            <span className="font-mono">
              {props.mismatchEvidence?.authenticated ?? "—"}
            </span>
            . Reconnect with the correct account on the platform.
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

        {plan?.kind === "api_key_verify" ? (
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
        {plan?.kind === "app_password" && !appPasswordFormOpen ? (
          <>
            <button
              type="button"
              onClick={() => {
                setAppPasswordFormOpen(true);
                setMessage(null);
                // Pre-fill the handle from the identity row so the
                // operator doesn't have to retype it.
                if (!appPasswordHandle) {
                  setAppPasswordHandle(props.accountId ? "" : "");
                }
              }}
              className="btn-primary text-[11px]"
            >
              {plan.buttonLabel}
            </button>
            <p className="basis-full text-[10px] text-ink-500 leading-relaxed italic mt-1">
              Public handle resolution alone does not connect the
              identity for publishing. The connect form authenticates
              against Bluesky using an App Password so Signal can post
              as this exact handle.
            </p>
          </>
        ) : null}

        {plan?.kind === "app_password" && appPasswordFormOpen ? (
          <form
            onSubmit={(e) => submitAppPassword(e, plan.connectUrl)}
            className="basis-full mt-2 rounded-md border border-ink-200 bg-ink-50/30 p-3 space-y-2"
          >
            <div className="text-[11px] font-semibold text-ink-900">
              Connect Bluesky identity
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
                . Signal stores the resulting session tokens encrypted
                and never the App Password.
              </span>
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy === "connect"}
                className="btn-primary text-[11px]"
              >
                {busy === "connect" ? "…" : "Authenticate"}
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
            {busy === "disconnect" ? "…" : "Disconnect"}
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
            {busy === "health" ? "…" : "Check connection"}
          </button>
        ) : null}
      </div>
      {message ? <div className="text-[10px] text-ink-600">{message}</div> : null}
    </div>
  );
}
