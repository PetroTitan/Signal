/**
 * Phase B2/B3/B4 — pure filter-state parsing, serialization, and
 * saved-view encoding for the Content Library + search surfaces.
 *
 * Filters live in the URL (shareable, survive refresh, server-readable)
 * and named "saved views" are encoded/decoded here so the client can
 * persist them (localStorage in this phase; a DB sync is a documented
 * follow-up — workspace_settings has no JSONB column yet). The actual
 * row filtering is done SERVER-SIDE in the repository; this module only
 * owns the (de)serialization + validation so it can be unit-tested.
 *
 * Pure module — no I/O, no React.
 */

export interface ContentFilterState {
  /** Free-text search (title / body / platform / permalink). */
  q: string;
  platform: string | null;
  /** weekly_plan_items.status token, or null for "any". */
  status: string | null;
  accountId: string | null;
  productId: string | null;
  /** Inclusive created/publish date bounds (YYYY-MM-DD), or null. */
  since: string | null;
  until: string | null;
}

export const EMPTY_CONTENT_FILTERS: ContentFilterState = {
  q: "",
  platform: null,
  status: null,
  accountId: null,
  productId: null,
  since: null,
  until: null,
};

type RawParams = Record<string, string | string[] | undefined>;

function one(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse URL search params into a normalized filter state. */
export function parseContentFilters(params: RawParams | undefined): ContentFilterState {
  const p = params ?? {};
  const since = one(p.since);
  const until = one(p.until);
  return {
    q: one(p.q) ?? "",
    platform: one(p.platform),
    status: one(p.status),
    accountId: one(p.account),
    productId: one(p.product),
    since: since && DATE_RE.test(since) ? since : null,
    until: until && DATE_RE.test(until) ? until : null,
  };
}

/** Serialize filter state back into a query string (stable key order). */
export function contentFiltersToQuery(state: ContentFilterState): string {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.platform) params.set("platform", state.platform);
  if (state.status) params.set("status", state.status);
  if (state.accountId) params.set("account", state.accountId);
  if (state.productId) params.set("product", state.productId);
  if (state.since) params.set("since", state.since);
  if (state.until) params.set("until", state.until);
  return params.toString();
}

export function isContentFilterActive(state: ContentFilterState): boolean {
  return (
    state.q !== "" ||
    state.platform !== null ||
    state.status !== null ||
    state.accountId !== null ||
    state.productId !== null ||
    state.since !== null ||
    state.until !== null
  );
}

// =====================================================================
// Saved views (client-persisted in this phase)
// =====================================================================

export interface SavedView {
  id: string;
  name: string;
  filters: ContentFilterState;
}

/**
 * Decode a saved-views blob (e.g. a localStorage string) into a safe,
 * validated array. Tolerant of malformed input — returns [] rather
 * than throwing, so a corrupt store never breaks the page.
 */
export function decodeSavedViews(raw: string | null | undefined): SavedView[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SavedView[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.name !== "string") continue;
    const f = (e.filters ?? {}) as Record<string, unknown>;
    out.push({
      id: e.id,
      name: e.name,
      filters: {
        q: typeof f.q === "string" ? f.q : "",
        platform: typeof f.platform === "string" ? f.platform : null,
        status: typeof f.status === "string" ? f.status : null,
        accountId: typeof f.accountId === "string" ? f.accountId : null,
        productId: typeof f.productId === "string" ? f.productId : null,
        since: typeof f.since === "string" ? f.since : null,
        until: typeof f.until === "string" ? f.until : null,
      },
    });
  }
  return out;
}

export function encodeSavedViews(views: SavedView[]): string {
  return JSON.stringify(views);
}

/** Upsert a saved view by id (create or replace), returning a new array. */
export function upsertSavedView(views: SavedView[], view: SavedView): SavedView[] {
  const idx = views.findIndex((v) => v.id === view.id);
  if (idx === -1) return [...views, view];
  const next = views.slice();
  next[idx] = view;
  return next;
}

export function removeSavedView(views: SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id);
}
