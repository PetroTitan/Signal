"use client";
/**
 * URL-driven navigation controls: tabs, search, state filter, paging.
 *
 * Everything here writes to the query string and lets the server
 * component re-render. Nothing filters or counts on the client, which is
 * the point — the client holds one page, and a total derived from one
 * page is the defect this milestone removes.
 *
 * The search box is the only control with client state, and only so it
 * can debounce. Typing pushes a URL after a pause rather than on every
 * keystroke; without that, a six-character handle costs six round trips
 * and six exact-count queries.
 */

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { BlueskyRelationshipState } from "@/lib/supabase/types";
import { relationshipLabel } from "@/core/bluesky-relationships/relationship-state";
import {
  RELATIONSHIP_STATES,
  type PageInfo,
  type RelationshipTab,
} from "@/core/bluesky-relationships/load-relationships.server.types";

/** Debounce, in ms. Long enough to skip intermediate keystrokes. */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * Build a URL preserving the parameters that should survive, and
 * resetting the ones that must not.
 *
 * Changing a tab, a search term or a filter ALWAYS resets the page to
 * 1. Page 7 of an unfiltered list is not page 7 of a filtered one, and
 * carrying the number over lands the operator on an empty page that
 * looks like "no results".
 */
function buildHref(
  pathname: string,
  current: URLSearchParams,
  patch: Record<string, string | null>,
): string {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function useRelationshipHref() {
  const pathname = usePathname();
  const params = useSearchParams();
  return (patch: Record<string, string | null>) =>
    buildHref(pathname, new URLSearchParams(params.toString()), patch);
}

export function TabStrip(props: {
  tabs: { key: RelationshipTab; label: string; count: number | null }[];
  active: RelationshipTab;
}) {
  const href = useRelationshipHref();
  return (
    <nav
      aria-label="Relationship views"
      className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto"
    >
      <ul className="flex gap-2 list-none p-0 m-0 w-max min-w-full">
        {props.tabs.map((t) => (
          <li key={t.key}>
            <Link
              // Tab, search and filters all reset paging.
              href={href({ tab: t.key, page: null, hpage: null })}
              aria-current={props.active === t.key ? "page" : undefined}
              className={`btn whitespace-nowrap ${
                props.active === t.key ? "nav-item-active border-signal-300" : ""
              }`}
            >
              {t.label}
              {t.count !== null ? (
                <span className="ml-1.5 text-ink-500">
                  {t.count.toLocaleString()}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function SearchAndFilter(props: {
  search: string;
  state: BlueskyRelationshipState | null;
  showStateFilter: boolean;
  counts: Record<BlueskyRelationshipState, number>;
  total: number;
}) {
  const router = useRouter();
  const href = useRelationshipHref();
  const [value, setValue] = useState(props.search);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the box in step when the URL changes underneath it — a tab
  // switch or a Back navigation must not leave a stale term visible.
  useEffect(() => {
    setValue(props.search);
  }, [props.search]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const push = (next: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      router.replace(href({ q: next.trim() || null, page: null }));
    }, SEARCH_DEBOUNCE_MS);
  };

  return (
    <section className="card card-padded space-y-3">
      <div className="flex flex-wrap gap-2">
        <label htmlFor="candidate-search" className="sr-only">
          Search by handle or name
        </label>
        <input
          id="candidate-search"
          type="search"
          value={value}
          placeholder="Search handle or name"
          className="input flex-1 min-w-0"
          onChange={(e) => {
            setValue(e.target.value);
            push(e.target.value);
          }}
        />
        {props.search ? (
          <Link href={href({ q: null, page: null })} className="btn-secondary">
            Clear
          </Link>
        ) : null}
      </div>

      {props.showStateFilter ? (
        <div className="-mx-1 px-1 overflow-x-auto">
          <div className="flex gap-2 w-max min-w-full">
            <Link
              href={href({ state: null, page: null })}
              aria-current={props.state === null ? "true" : undefined}
              className={`btn whitespace-nowrap ${
                props.state === null ? "nav-item-active border-signal-300" : ""
              }`}
            >
              All
              <span className="ml-1.5 text-ink-500">
                {props.total.toLocaleString()}
              </span>
            </Link>
            {RELATIONSHIP_STATES.map((s) => (
              <Link
                key={s}
                href={href({ state: s, page: null })}
                aria-current={props.state === s ? "true" : undefined}
                className={`btn whitespace-nowrap ${
                  props.state === s ? "nav-item-active border-signal-300" : ""
                }`}
              >
                {relationshipLabel(s)}
                <span className="ml-1.5 text-ink-500">
                  {props.counts[s].toLocaleString()}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Pager.
 *
 * States the exact range and the exact total, both from Postgres. "1-50
 * of 4,128" is the sentence the old surface could not say, because it
 * only ever had 500 rows and no idea whether that was all of them.
 */
export function Pager(props: { info: PageInfo; param: "page" | "hpage"; label: string }) {
  const href = useRelationshipHref();
  const { page, pageSize, total, totalPages } = props.info;
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const prev = page > 1 ? String(page - 1) : null;
  const next = page < totalPages ? String(page + 1) : null;

  return (
    <nav
      aria-label={`${props.label} pagination`}
      className="flex flex-wrap items-center gap-2 justify-between"
    >
      <p className="text-sm text-ink-600">
        {first.toLocaleString()}–{last.toLocaleString()} of{" "}
        <span className="font-medium text-ink-900">{total.toLocaleString()}</span>
      </p>
      <div className="flex items-center gap-2">
        {prev ? (
          <Link href={href({ [props.param]: prev })} className="btn-secondary">
            Previous
          </Link>
        ) : (
          <span className="btn-secondary opacity-40" aria-disabled="true">
            Previous
          </span>
        )}
        <span className="text-sm text-ink-600 whitespace-nowrap">
          {page} / {totalPages}
        </span>
        {next ? (
          <Link href={href({ [props.param]: next })} className="btn-secondary">
            Next
          </Link>
        ) : (
          <span className="btn-secondary opacity-40" aria-disabled="true">
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
