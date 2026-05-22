"use client";

import { useState } from "react";

interface ConnectionControlsProps {
  platform: "reddit" | "x" | "linkedin";
  accountId: string;
  providerConfigured: boolean;
  encryptionConfigured: boolean;
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
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error ?? "Health check failed.");
      } else {
        setMessage(`${json.health}: ${json.message}`);
      }
    } finally {
      setBusy(null);
    }
  }

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
      {!providerConfigured ? (
        <div className="text-[10px] text-amber-700">
          OAuth app not configured yet.
        </div>
      ) : !encryptionConfigured ? (
        <div className="text-[10px] text-amber-700">
          Token encryption not configured — tokens will not be stored.
        </div>
      ) : null}
      <div className="flex gap-2 flex-wrap mt-1">
        {providerConfigured ? (
          <a
            href={`/api/oauth/${platform}/start?account_id=${encodeURIComponent(
              accountId,
            )}&redirect_after=${encodeURIComponent("/accounts")}`}
            className="btn-primary text-[11px]"
          >
            {props.connectionStatus === "connected"
              ? "Reauthorize"
              : "Connect via OAuth"}
          </a>
        ) : null}
        {props.connectionStatus === "connected" ||
        props.connectionStatus === "expired" ||
        props.connectionStatus === "reauthorization_required" ||
        props.connectionStatus === "error" ? (
          <button
            type="button"
            onClick={disconnect}
            disabled={busy === "disconnect"}
            className="btn-secondary text-[11px]"
          >
            {busy === "disconnect" ? "…" : "Disconnect"}
          </button>
        ) : null}
        {props.hasAccessToken || props.connectionStatus !== "not_connected" ? (
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
