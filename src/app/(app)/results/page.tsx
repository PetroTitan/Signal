import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listPublishHistoryPage } from "@/repositories/publish-history-repository";
import { hydrateExecutionItemDisplay } from "@/repositories/execution-item-repository";
import { listPostMetricsForPublishHistory } from "@/repositories/post-metrics-repository";
import {
  describeMetrics,
  metricCapability,
  type VerifiedMetrics,
} from "@/core/metrics/metrics-provider";
import type { PostMetricsStatus } from "@/lib/supabase/types";
import { MetricsRefreshButton } from "./_metrics-refresh-button";
import { listAccounts } from "@/repositories/account-repository";
import { PlatformChip } from "@/components/publishing/platform-chip";
import { parsePageParam, parseSearchQuery } from "@/core/dashboard/workflow-filters";
import {
  assembleResult,
  formatPublishDuration,
  type ResultRecord,
} from "@/core/publishing/results-view";

export const dynamic = "force-dynamic";

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function ResultsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Results" description="Persistence not configured." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Supabase is not configured.
        </div>
      </>
    );
  }
  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Results" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace to start.
        </div>
      </>
    );
  }
  const workspaceId = membership.workspace.id;
  const page = parsePageParam(searchParams?.page);
  const query = parseSearchQuery(searchParams?.q);
  const platform =
    typeof searchParams?.platform === "string" && searchParams.platform.trim()
      ? searchParams.platform.trim()
      : null;

  const result = await listPublishHistoryPage(
    workspaceId,
    { outcomes: ["published"], platform, query: query || null },
    page,
    20,
  );
  const [display, accounts, metricsCache] = await Promise.all([
    hydrateExecutionItemDisplay(
      workspaceId,
      result.rows.map((r) => r.executionItemId),
    ),
    listAccounts(workspaceId),
    // C3 — verified metrics cache for this page (read-only; never faked).
    listPostMetricsForPublishHistory(
      workspaceId,
      result.rows.map((r) => r.id),
    ),
  ]);
  const accountLabel = new Map(
    accounts.map((a) => [a.id, a.displayName || a.handle || a.platform] as const),
  );

  // Per-row metrics view: a cached verified record when present,
  // otherwise the platform capability ('pending' for verifiable
  // platforms not yet fetched, 'unavailable'/'unsupported' otherwise).
  const metricsView = new Map<
    string,
    { status: PostMetricsStatus; text: string; canRefresh: boolean }
  >();
  for (const r of result.rows) {
    const cached = metricsCache.get(r.id);
    const capability = metricCapability(r.platform);
    const canRefresh = capability === "verified";
    if (cached) {
      metricsView.set(r.id, {
        status: cached.status,
        text: describeMetrics({
          status: cached.status,
          metrics: cached.metrics as VerifiedMetrics,
        }),
        canRefresh,
      });
    } else {
      const status: PostMetricsStatus =
        capability === "verified"
          ? "pending"
          : capability === "unavailable"
            ? "unavailable"
            : "unsupported";
      metricsView.set(r.id, {
        status,
        text: describeMetrics({ status, metrics: {} }),
        canRefresh,
      });
    }
  }

  const records: ResultRecord[] = result.rows.map((r) => {
    const d = display.get(r.executionItemId);
    const notes =
      typeof d?.metadata?.operator_notes === "string"
        ? (d.metadata.operator_notes as string)
        : null;
    return assembleResult({
      row: {
        id: r.id,
        executionItemId: r.executionItemId,
        platform: r.platform,
        subreddit: r.subreddit,
        outcome: r.outcome,
        permalink: r.providerPermalink,
        providerPostId: r.providerPostId,
        startedAtIso: r.startedAt,
        finishedAtIso: r.finishedAt,
        mode: r.mode,
        reasonCode: r.reasonCode,
      },
      context: {
        title: d?.title ?? null,
        identityLabel: d?.accountId ? accountLabel.get(d.accountId) ?? null : null,
        operatorNotes: notes,
        attemptCount: d?.attemptCount ?? null,
        logs: [], // per-item retry log lives on the item detail page
      },
      // Metrics extension point — no verified provider source wired yet.
      metrics: null,
    });
  });

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (platform) params.set("platform", platform);
    params.set("page", String(p));
    return `/results?${params.toString()}`;
  };

  return (
    <>
      <Topbar
        title="Results"
        description="What actually went out. Read from publish history — real permalinks, timings, and outcomes only."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-4">
        <form method="get" action="/results" className="flex items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search platform / subreddit / permalink…"
            className="input flex-1 min-w-0"
          />
          {platform ? <input type="hidden" name="platform" value={platform} /> : null}
          <button type="submit" className="btn shrink-0">Search</button>
          {query ? (
            <Link href="/results" className="btn-ghost shrink-0 text-ink-500">Clear</Link>
          ) : null}
        </form>

        <section className="card overflow-hidden">
          {records.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-ink-500">
              No published posts yet. They&apos;ll appear here once the scheduler
              publishes something.
            </div>
          ) : (
            <ul className="row-divider">
              {records.map((r) => (
                <li key={r.id} className="px-4 sm:px-5 py-3 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-ink-900 truncate max-w-[20rem]">
                        {r.title?.trim() || "Untitled"}
                      </span>
                      <PlatformChip platform={r.platform} />
                      {r.subreddit ? (
                        <span className="text-[11px] text-ink-500 font-mono">r/{r.subreddit}</span>
                      ) : null}
                      {r.retried ? (
                        <span className="text-[10px] rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5">
                          retried
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-ink-500 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>{fmtDateTime(r.publishedAtIso)}</span>
                      {r.identityLabel ? <span>· {r.identityLabel}</span> : null}
                      <span>· {r.mode === "manual" ? "manual" : "auto"}</span>
                      <span>· took {formatPublishDuration(r.publishDurationMs)}</span>
                      {/* C3 — verified metrics only (or an honest state). */}
                      {(() => {
                        const mv = metricsView.get(r.id);
                        if (!mv) return null;
                        const connected = mv.status === "connected";
                        return (
                          <span className="inline-flex items-center gap-1.5">
                            <span className={connected ? "text-ink-600" : "text-ink-400"}>
                              · {mv.text}
                            </span>
                            {mv.canRefresh ? (
                              <>
                                <span className="text-ink-300">·</span>
                                <MetricsRefreshButton publishHistoryId={r.id} />
                              </>
                            ) : null}
                          </span>
                        );
                      })()}
                    </div>
                    {r.operatorNotes ? (
                      <p className="text-[11px] text-ink-600 mt-1 line-clamp-2">
                        Note: {r.operatorNotes}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 flex flex-col items-end gap-1">
                    {r.permalink ? (
                      <a
                        href={r.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-emerald-700 hover:text-emerald-800"
                      >
                        Open ↗
                      </a>
                    ) : null}
                    <Link
                      href={r.detailHref}
                      className="text-[11px] text-signal-700 hover:text-signal-800"
                    >
                      Details →
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {result.total > 0 ? (
            <div className="px-4 sm:px-5 py-3 border-t border-ink-100 flex items-center justify-between gap-3">
              <span className="text-[11px] text-ink-500">
                {(result.page - 1) * result.pageSize + 1}&ndash;
                {Math.min(result.page * result.pageSize, result.total)} of {result.total}
              </span>
              <div className="flex items-center gap-2">
                {result.page > 1 ? (
                  <Link href={pageHref(result.page - 1)} className="btn text-xs" rel="prev">← Prev</Link>
                ) : (
                  <span className="btn text-xs opacity-40 pointer-events-none">← Prev</span>
                )}
                <span className="text-[11px] text-ink-500 tabular-nums">
                  Page {result.page} of {result.totalPages}
                </span>
                {result.page < result.totalPages ? (
                  <Link href={pageHref(result.page + 1)} className="btn text-xs" rel="next">Next →</Link>
                ) : (
                  <span className="btn text-xs opacity-40 pointer-events-none">Next →</span>
                )}
              </div>
            </div>
          ) : null}
        </section>

        <p className="text-[11px] text-ink-500 leading-relaxed">
          Metrics are intentionally empty until a verified provider source is
          connected — Signal never estimates engagement or invents reach.
        </p>
      </div>
    </>
  );
}
