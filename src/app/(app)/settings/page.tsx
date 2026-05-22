"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { LockIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import { useDemoMode } from "@/core/demo-mode";
import {
  getActiveAiProvider,
  ALLOWED_AI_USE_CASES,
  USE_CASE_LABELS,
} from "@/core/ai";
import {
  CONNECTION_STATUS_LABELS,
  CONNECTION_STATUS_USER_HINTS,
  MockConnectionProvider,
  PLATFORM_CAPABILITY_PROFILES,
  type PlatformConnection,
} from "@/core/platform-connections";
import { useEffect, useState } from "react";

export default function SettingsPage() {
  const { state } = useSignal();
  const { demoMode, setDemoMode } = useDemoMode();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );
  const accounts = useMemo(
    () => Object.values(state.accountsById),
    [state.accountsById],
  );
  const aiProvider = useMemo(() => getActiveAiProvider(), []);
  const [connections, setConnections] = useState<PlatformConnection[]>([]);
  useEffect(() => {
    const provider = new MockConnectionProvider();
    provider.list("ws_helperg").then(setConnections);
  }, []);

  return (
    <>
      <Topbar
        title="Settings"
        description="Workspace, connections, AI, and trust."
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Demo data</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Off by default. Signal shows real empty states unless this is on.
          </p>
          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="text-sm text-ink-800">
              {demoMode ? "Demo data is on" : "Demo data is off"}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={demoMode}
              onClick={() => setDemoMode(!demoMode)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                demoMode ? "bg-signal-600" : "bg-ink-200"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                  demoMode ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Platform connections
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            OAuth integrations are not enabled yet. Signal will never ask for
            passwords, cookies, session tokens, 2FA codes, or recovery codes.
          </p>
          <ul className="mt-4 divide-y divide-ink-100">
            {connections.map((c) => (
              <ConnectionRow key={c.id} connection={c} />
            ))}
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">AI provider</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Local preview mode. No external AI calls. Configured securely on the
            server when integrations are enabled.
          </p>
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="badge-neutral text-[10px]">
              {aiProvider.meta.label}
            </span>
            <span className="text-xs text-ink-500">
              {aiProvider.meta.connected
                ? "Connected"
                : "Not connected"}
            </span>
          </div>
          <div className="mt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              Allowed use cases
            </div>
            <ul className="mt-1 grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-ink-700">
              {ALLOWED_AI_USE_CASES.map((u) => (
                <li key={u}>· {USE_CASE_LABELS[u]}</li>
              ))}
            </ul>
          </div>
          <div className="mt-3 text-[11px] text-ink-500 leading-relaxed">
            AI runs server-side when configured. Output requires human approval
            before publishing.
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Workspace</h2>
          <p className="text-xs text-ink-500 mt-1">
            Single-workspace mode. Multi-workspace ships with Supabase.
          </p>
          <div className="mt-3 text-sm text-ink-800 space-y-1">
            <div>
              {products.length} product{products.length === 1 ? "" : "s"}{" "}
              configured
            </div>
            <div>
              {accounts.length} account{accounts.length === 1 ? "" : "s"} defined
            </div>
          </div>
        </section>

        <section className="card p-5 flex items-start gap-3 text-sm">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
            <LockIcon />
          </span>
          <div>
            <div className="font-semibold text-ink-900">OAuth-first</div>
            <p className="text-ink-700 mt-0.5 leading-relaxed">
              Signal never asks for platform passwords, cookies, session tokens,
              2FA codes, or recovery codes. Accounts connect through official
              OAuth when integrations are enabled.
            </p>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Persistence (planned)
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Supabase persistence is planned. The schema is documented before any
            migration is written. Nothing is stored on a server today.
          </p>
        </section>
      </div>
    </>
  );
}

function ConnectionRow({ connection }: { connection: PlatformConnection }) {
  const profile = PLATFORM_CAPABILITY_PROFILES[connection.channel];
  return (
    <li className="py-3 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">{profile.label}</div>
        <div className="text-xs text-ink-500 mt-0.5 leading-relaxed">
          {profile.shortDescription}
        </div>
        <div className="text-xs text-ink-500 mt-1">
          {CONNECTION_STATUS_LABELS[connection.connectionStatus]} ·{" "}
          {CONNECTION_STATUS_USER_HINTS[connection.connectionStatus]}
        </div>
      </div>
      <button
        type="button"
        disabled
        className="btn shrink-0 opacity-60 cursor-not-allowed"
        title="OAuth integrations are not enabled yet."
      >
        Connect via official OAuth
      </button>
    </li>
  );
}
