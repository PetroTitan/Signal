"use client";

import { useState } from "react";
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
        setMessage("Identity verified.");
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
