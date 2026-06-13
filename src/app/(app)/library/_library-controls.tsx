"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  contentFiltersToQuery,
  decodeSavedViews,
  encodeSavedViews,
  removeSavedView,
  upsertSavedView,
  type ContentFilterState,
  type SavedView,
} from "@/core/dashboard/content-filters";

/**
 * Phase B2/B3 — Content Library filter bar + saved views.
 *
 * Filters are URL-driven (a GET form, shareable + refresh-surviving).
 * Named saved views persist in localStorage in this phase (no DB JSONB
 * column yet — DB sync is a documented follow-up); each view restores
 * the full filter state. Counts/results are always recomputed
 * server-side from the URL, so a saved view can never drift from the
 * source of truth.
 */

const STORAGE_KEY = "signal.library.savedViews.v1";

export interface LibraryControlsProps {
  current: ContentFilterState;
  platforms: string[];
  statuses: string[];
  accounts: { id: string; label: string }[];
  products: { id: string; name: string }[];
}

export function LibraryControls(props: LibraryControlsProps) {
  const router = useRouter();
  const [views, setViews] = useState<SavedView[]>([]);
  const [name, setName] = useState("");

  useEffect(() => {
    setViews(decodeSavedViews(window.localStorage.getItem(STORAGE_KEY)));
  }, []);

  function persist(next: SavedView[]) {
    setViews(next);
    window.localStorage.setItem(STORAGE_KEY, encodeSavedViews(next));
  }

  function saveCurrent() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `v_${Date.now()}`;
    persist(upsertSavedView(views, { id, name: trimmed, filters: props.current }));
    setName("");
  }

  function applyView(view: SavedView) {
    const qs = contentFiltersToQuery(view.filters);
    router.push(qs ? `/library?${qs}` : "/library");
  }

  return (
    <div className="space-y-3">
      {/* URL-driven filter form (server reads these on submit). */}
      <form method="get" action="/library" className="card p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="text-[11px] text-ink-500">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={props.current.q}
            placeholder="Title, body, platform…"
            className="input w-full mt-0.5"
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-500">Platform</span>
          <select name="platform" defaultValue={props.current.platform ?? ""} className="input w-full mt-0.5">
            <option value="">Any platform</option>
            {props.platforms.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-500">Status</span>
          <select name="status" defaultValue={props.current.status ?? ""} className="input w-full mt-0.5">
            <option value="">Any status</option>
            {props.statuses.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-500">Identity</span>
          <select name="account" defaultValue={props.current.accountId ?? ""} className="input w-full mt-0.5">
            <option value="">Any identity</option>
            {props.accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-ink-500">Product</span>
          <select name="product" defaultValue={props.current.productId ?? ""} className="input w-full mt-0.5">
            <option value="">Any product</option>
            {props.products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[11px] text-ink-500">From</span>
            <input type="date" name="since" defaultValue={props.current.since ?? ""} className="input w-full mt-0.5" />
          </label>
          <label className="block">
            <span className="text-[11px] text-ink-500">To</span>
            <input type="date" name="until" defaultValue={props.current.until ?? ""} className="input w-full mt-0.5" />
          </label>
        </div>
        <div className="sm:col-span-2 lg:col-span-3 flex items-center gap-2">
          <button type="submit" className="btn-primary">Apply filters</button>
          <a href="/library" className="btn-ghost text-ink-500">Clear</a>
        </div>
      </form>

      {/* Saved views (localStorage). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-ink-500">Saved views:</span>
        {views.length === 0 ? (
          <span className="text-[11px] text-ink-400">none yet</span>
        ) : (
          views.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1 rounded-full border border-ink-200 bg-white pl-2.5 pr-1 py-0.5 text-[11px]">
              <button type="button" onClick={() => applyView(v)} className="text-ink-700 hover:text-signal-700">
                {v.name}
              </button>
              <button
                type="button"
                onClick={() => persist(removeSavedView(views, v.id))}
                aria-label={`Delete view ${v.name}`}
                className="text-ink-400 hover:text-red-600 px-1"
              >
                ×
              </button>
            </span>
          ))
        )}
        <span className="inline-flex items-center gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Save current as…"
            className="input text-[11px] py-1"
          />
          <button type="button" onClick={saveCurrent} disabled={!name.trim()} className="btn text-[11px] disabled:opacity-50">
            Save
          </button>
        </span>
      </div>
    </div>
  );
}
