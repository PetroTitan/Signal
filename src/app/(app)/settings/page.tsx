"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { LockIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import { useDemoMode } from "@/core/demo-mode";

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

  return (
    <>
      <Topbar title="Settings" description="Workspace, demo data, and trust." />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Demo data</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Off by default. When off, Signal shows real empty states — no fake
            accounts, no synthetic queues, no fabricated metrics. Turn on to
            explore the workflow with sample data clearly labeled as demo.
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
          <h2 className="text-sm font-semibold text-ink-900">Workspace</h2>
          <p className="text-xs text-ink-500 mt-1">
            Single-workspace mode. Multi-workspace ships with Supabase.
          </p>
          <div className="mt-3 text-sm text-ink-800 space-y-1">
            <div>
              {products.length} product{products.length === 1 ? "" : "s"} configured
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
