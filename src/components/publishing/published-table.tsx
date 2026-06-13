/**
 * Compact, paginated table for published (and failed) history.
 *
 * Dashboard Organization Pass — Phase 3. Replaces the large workflow
 * cards for the Published view so a workspace with hundreds/thousands
 * of published posts renders ~20 dense rows instead of a wall of
 * cards.
 *
 * Pure server component. SSR-first: search is a GET form and
 * pagination is plain links, so it works with JavaScript disabled and
 * needs no client bundle. Columns: Date · Platform · Title · Status ·
 * Open. Status reflects REAL DB state (publish outcome / item status);
 * the table never derives a fake status.
 */

import Link from "next/link";
import { PlatformChip } from "./platform-chip";
import type { Paginated } from "@/core/dashboard/workflow-filters";

export type PublishedRowTone = "success" | "danger" | "warn" | "muted";

export interface PublishedTableRow {
  id: string;
  title: string | null;
  platform: string;
  subreddit: string | null;
  /** ISO publish/finished time, or null when unknown. */
  date: string | null;
  /** Founder-readable status label, e.g. "Published" / "Failed". */
  statusLabel: string;
  statusTone: PublishedRowTone;
  /** Optional second line under the title — e.g. the operator-readable
   *  failure reason on the Failed view. */
  subtitle?: string | null;
  /** External permalink (preferred Open target). */
  permalink: string | null;
  /** Internal detail href, used when there is no external permalink. */
  detailHref: string | null;
}

const TONE_CLASS: Record<PublishedRowTone, string> = {
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  danger: "bg-red-50 text-red-700 border-red-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  muted: "bg-ink-50 text-ink-500 border-ink-100",
};

export interface PublishedTableProps {
  /** Already-filtered + ordered + paginated rows for the current page. */
  page: Paginated<PublishedTableRow>;
  /** Path the search form + pagination links point at (e.g. /weekly-plan). */
  basePath: string;
  /** Query params to preserve on every link/submit (e.g. { tab: "published" }). */
  baseParams: Record<string, string>;
  /** Current search query (echoed into the input). */
  query: string;
  /** Whether to render the search box. */
  searchable?: boolean;
  /** Copy for the zero-rows state. */
  emptyLabel?: string;
  /** Accessible caption / heading for the table. */
  caption: string;
}

function buildHref(
  basePath: string,
  baseParams: Record<string, string>,
  overrides: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(baseParams)) {
    if (v) params.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === "" || v === null) {
      params.delete(k);
    } else {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function PublishedTable({
  page,
  basePath,
  baseParams,
  query,
  searchable = true,
  emptyLabel = "Nothing here yet.",
  caption,
}: PublishedTableProps) {
  const { items, total, startIndex, endIndex, hasPrev, hasNext } = page;

  return (
    <section className="card overflow-hidden">
      {searchable ? (
        <div className="px-4 sm:px-5 py-3 border-b border-ink-100">
          <form method="get" action={basePath} className="flex items-center gap-2">
            {Object.entries(baseParams).map(([k, v]) =>
              v ? <input key={k} type="hidden" name={k} value={v} /> : null,
            )}
            <label htmlFor="published-search" className="sr-only">
              Search published posts
            </label>
            <input
              id="published-search"
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search by title, platform, or subreddit…"
              className="input flex-1 min-w-0"
            />
            <button type="submit" className="btn shrink-0">
              Search
            </button>
            {query ? (
              <Link
                href={buildHref(basePath, baseParams, { q: undefined, page: undefined })}
                className="btn-ghost shrink-0 text-ink-500"
              >
                Clear
              </Link>
            ) : null}
          </form>
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="px-5 py-10 text-center text-sm text-ink-500">
          {query ? (
            <>No results for &ldquo;{query}&rdquo;.</>
          ) : (
            emptyLabel
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-100">
                <th scope="col" className="px-4 sm:px-5 py-2.5 font-semibold whitespace-nowrap">
                  Date
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold hidden sm:table-cell">
                  Platform
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">
                  Title
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold whitespace-nowrap">
                  Status
                </th>
                <th scope="col" className="px-4 sm:px-5 py-2.5 font-semibold text-right">
                  Open
                </th>
              </tr>
            </thead>
            <tbody className="row-divider">
              {items.map((row) => (
                <tr key={row.id} className="align-middle hover:bg-ink-50/60">
                  <td className="px-4 sm:px-5 py-2.5 text-ink-600 whitespace-nowrap">
                    {formatDate(row.date)}
                  </td>
                  <td className="px-3 py-2.5 hidden sm:table-cell">
                    <PlatformChip platform={row.platform} />
                  </td>
                  <td className="px-3 py-2.5 min-w-0">
                    <div className="text-ink-900 font-medium truncate max-w-[22rem]">
                      {row.title?.trim() || "Untitled"}
                    </div>
                    {row.subtitle ? (
                      <div className="text-[11px] text-ink-600 mt-0.5 truncate max-w-[22rem]">
                        {row.subtitle}
                      </div>
                    ) : null}
                    <div className="text-[11px] text-ink-500 mt-0.5 flex items-center gap-1.5 sm:hidden">
                      <PlatformChip platform={row.platform} />
                      {row.subreddit ? (
                        <span className="font-mono">r/{row.subreddit}</span>
                      ) : null}
                    </div>
                    {row.subreddit ? (
                      <span className="hidden sm:inline text-[11px] text-ink-500 font-mono">
                        r/{row.subreddit}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONE_CLASS[row.statusTone]}`}
                    >
                      {row.statusLabel}
                    </span>
                  </td>
                  <td className="px-4 sm:px-5 py-2.5 text-right whitespace-nowrap">
                    {row.permalink ? (
                      <a
                        href={row.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-signal-700 hover:text-signal-800"
                      >
                        Open ↗
                      </a>
                    ) : row.detailHref ? (
                      <Link
                        href={row.detailHref}
                        className="text-xs font-medium text-signal-700 hover:text-signal-800"
                      >
                        View →
                      </Link>
                    ) : (
                      <span className="text-xs text-ink-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > 0 ? (
        <div className="px-4 sm:px-5 py-3 border-t border-ink-100 flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-500">
            {startIndex}&ndash;{endIndex} of {total}
          </span>
          <div className="flex items-center gap-2">
            {hasPrev ? (
              <Link
                href={buildHref(basePath, baseParams, {
                  q: query || undefined,
                  page: page.page - 1,
                })}
                className="btn text-xs"
                rel="prev"
              >
                ← Prev
              </Link>
            ) : (
              <span className="btn text-xs opacity-40 pointer-events-none" aria-disabled>
                ← Prev
              </span>
            )}
            <span className="text-[11px] text-ink-500 tabular-nums">
              Page {page.page} of {page.totalPages}
            </span>
            {hasNext ? (
              <Link
                href={buildHref(basePath, baseParams, {
                  q: query || undefined,
                  page: page.page + 1,
                })}
                className="btn text-xs"
                rel="next"
              >
                Next →
              </Link>
            ) : (
              <span className="btn text-xs opacity-40 pointer-events-none" aria-disabled>
                Next →
              </span>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
