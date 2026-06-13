import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listPlanItemsPage } from "@/repositories/weekly-plan-repository";
import { listAccounts } from "@/repositories/account-repository";
import { listProducts } from "@/repositories/product-repository";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { PlatformChip } from "@/components/publishing/platform-chip";
import {
  parseContentFilters,
  contentFiltersToQuery,
} from "@/core/dashboard/content-filters";
import { parsePageParam } from "@/core/dashboard/workflow-filters";
import { LibraryControls } from "./_library-controls";
import { AdaptControl } from "../weekly-plan/_adapt-control";

export const dynamic = "force-dynamic";

const STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "published",
  "paused",
  "skipped",
  "rejected",
  "backlog",
];
const PLATFORMS = [
  "reddit",
  "x",
  "bluesky",
  "telegram",
  "devto",
  "hashnode",
  "linkedin",
  "threads",
  "instagram",
  "youtube",
];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default async function ContentLibraryPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Content Library" description="Persistence not configured." />
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
        <Topbar title="Content Library" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace to start.
        </div>
      </>
    );
  }
  const workspaceId = membership.workspace.id;
  const filters = parseContentFilters(searchParams);
  const page = parsePageParam(searchParams?.page);

  const [result, accounts, products] = await Promise.all([
    listPlanItemsPage(
      workspaceId,
      {
        q: filters.q || null,
        platform: filters.platform,
        status: filters.status,
        accountId: filters.accountId,
        productId: filters.productId,
        sinceIso: filters.since ? `${filters.since}T00:00:00.000Z` : null,
        untilIso: filters.until ? `${filters.until}T23:59:59.999Z` : null,
      },
      page,
      20,
    ),
    listAccounts(workspaceId),
    listProducts(workspaceId),
  ]);

  const accountLabel = new Map(
    accounts.map((a) => [a.id, a.displayName || a.handle || a.platform] as const),
  );
  const productName = new Map(products.map((p) => [p.id, p.name] as const));

  const baseQuery = contentFiltersToQuery(filters);
  const pageHref = (p: number) => {
    const params = new URLSearchParams(baseQuery);
    params.set("page", String(p));
    return `/library?${params.toString()}`;
  };

  return (
    <>
      <Topbar
        title="Content Library"
        description="Every post across all weeks. Search, filter, and reuse — read from the live source of truth."
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-4">
        <LibraryControls
          current={filters}
          platforms={PLATFORMS}
          statuses={STATUSES}
          accounts={accounts.map((a) => ({
            id: a.id,
            label: a.displayName || a.handle || a.platform,
          }))}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
        />

        <section className="card overflow-hidden">
          {result.rows.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-ink-500">
              No content matches these filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-ink-500 border-b border-ink-100">
                    <th className="px-4 sm:px-5 py-2.5 font-semibold">Title</th>
                    <th className="px-3 py-2.5 font-semibold hidden sm:table-cell">Platform</th>
                    <th className="px-3 py-2.5 font-semibold">Status</th>
                    <th className="px-3 py-2.5 font-semibold hidden md:table-cell">Identity</th>
                    <th className="px-3 py-2.5 font-semibold whitespace-nowrap hidden lg:table-cell">Created</th>
                    <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Scheduled</th>
                    <th className="px-4 sm:px-5 py-2.5 font-semibold text-right">Open</th>
                  </tr>
                </thead>
                <tbody className="row-divider">
                  {result.rows.map((it) => (
                    <tr key={it.id} className="align-middle hover:bg-ink-50/60">
                      <td className="px-4 sm:px-5 py-2.5 min-w-0">
                        <div className="text-ink-900 font-medium truncate max-w-[22rem]">
                          {it.title?.trim() || "Untitled"}
                        </div>
                        {it.productId && productName.get(it.productId) ? (
                          <div className="text-[11px] text-ink-500">{productName.get(it.productId)}</div>
                        ) : null}
                        <div className="mt-1.5">
                          <AdaptControl itemId={it.id} sourcePlatform={it.platform} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 hidden sm:table-cell">
                        {it.platform ? <PlatformChip platform={it.platform} /> : <span className="text-ink-400">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <ExecutionStateBadge status={it.status} />
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell text-ink-600 text-[12px]">
                        {it.accountId ? accountLabel.get(it.accountId) ?? "—" : "—"}
                      </td>
                      <td className="px-3 py-2.5 hidden lg:table-cell text-ink-600 whitespace-nowrap">
                        {fmtDate(it.createdAt)}
                      </td>
                      <td className="px-3 py-2.5 text-ink-600 whitespace-nowrap">
                        {fmtDate(it.scheduledAt)}
                      </td>
                      <td className="px-4 sm:px-5 py-2.5 text-right whitespace-nowrap">
                        <Link
                          href={`/weekly-plan?focus=${it.id}`}
                          className="text-xs font-medium text-signal-700 hover:text-signal-800"
                        >
                          Open →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
          Looking for published permalinks + outcomes? See{" "}
          <Link href="/results" className="text-signal-700 hover:text-signal-800">Results</Link>.
        </p>
      </div>
    </>
  );
}
