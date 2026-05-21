"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/section-header";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import { searchAll, type SearchResult, type SearchEntityType } from "@/core/search";
import { contentAssets, riskEvents, sourceInsights } from "@/lib/mock";

const entityLabels: Record<SearchEntityType, string> = {
  product: "Product",
  account: "Account",
  weekly_item: "Plan item",
  backlog_item: "Backlog item",
  insight: "Insight",
  content_asset: "Content asset",
  risk: "Risk signal",
  docs: "Docs",
};

const entityTones: Record<SearchEntityType, string> = {
  product: "bg-signal-50 text-signal-700",
  account: "bg-emerald-50 text-emerald-700",
  weekly_item: "bg-amber-50 text-amber-700",
  backlog_item: "bg-ink-100 text-ink-700",
  insight: "bg-signal-50 text-signal-700",
  content_asset: "bg-ink-900 text-white",
  risk: "bg-red-50 text-red-700",
  docs: "bg-ink-100 text-ink-700",
};

export default function SearchPage() {
  const { state } = useSignal();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | SearchEntityType>("all");

  const results = useMemo(() => {
    const out = searchAll({
      query,
      products: Object.values(state.productsById),
      accounts: Object.values(state.accountsById),
      items: state.items,
      backlog: state.backlog,
      insights: sourceInsights,
      contentAssets,
      riskEvents,
    });
    if (filter === "all") return out;
    return out.filter((r) => r.type === filter);
  }, [
    query,
    filter,
    state.productsById,
    state.accountsById,
    state.items,
    state.backlog,
  ]);

  const groups = useMemo(() => {
    const map = new Map<SearchEntityType, SearchResult[]>();
    for (const r of results) {
      const list = map.get(r.type) ?? [];
      list.push(r);
      map.set(r.type, list);
    }
    return Array.from(map.entries());
  }, [results]);

  return (
    <>
      <Topbar
        title="Search"
        description="Internal search across products, accounts, plan items, backlog, insights, content assets, and risk."
      />

      <div className="px-6 lg:px-8 py-6 max-w-5xl space-y-6">
        <SearchBox value={query} onChange={setQuery} />

        {query.trim().length >= 2 ? (
          <>
            <FilterChips filter={filter} setFilter={setFilter} results={results} />
            {results.length === 0 ? (
              <EmptyState
                title="No matches"
                description="Try a shorter query, or search for an account, insight title, or platform."
              />
            ) : (
              <div className="space-y-4">
                {groups.map(([type, rows]) => (
                  <section key={type} className="card">
                    <SectionHeader
                      title={`${entityLabels[type]} · ${rows.length}`}
                      hint={hintFor(type)}
                    />
                    <ul className="row-divider">
                      {rows.slice(0, 20).map((r) => (
                        <ResultRow key={`${type}-${r.id}`} result={r} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        ) : (
          <Hints />
        )}
      </div>
    </>
  );
}

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="card-padded">
      <label htmlFor="search-q" className="stat-label">
        Search
      </label>
      <input
        id="search-q"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search products, accounts, insights, items, assets…"
        className="w-full mt-1 border border-ink-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-signal-300 focus:border-signal-500"
        autoFocus
      />
      <p className="text-[11px] text-ink-500 mt-1">
        Type at least 2 characters. Results match exact, prefix, word-boundary,
        and substring hits.
      </p>
    </div>
  );
}

function FilterChips({
  filter,
  setFilter,
  results,
}: {
  filter: "all" | SearchEntityType;
  setFilter: (f: "all" | SearchEntityType) => void;
  results: SearchResult[];
}) {
  const counts = new Map<"all" | SearchEntityType, number>();
  counts.set("all", results.length);
  for (const r of results) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const buttons: { key: "all" | SearchEntityType; label: string }[] = [
    { key: "all", label: "All" },
    { key: "product", label: "Products" },
    { key: "account", label: "Accounts" },
    { key: "weekly_item", label: "Items" },
    { key: "backlog_item", label: "Backlog" },
    { key: "insight", label: "Insights" },
    { key: "content_asset", label: "Assets" },
    { key: "risk", label: "Risk" },
    { key: "docs", label: "Docs" },
  ];
  return (
    <div className="card p-1.5 inline-flex flex-wrap gap-1">
      {buttons.map((b) => {
        const c = counts.get(b.key) ?? 0;
        return (
          <button
            key={b.key}
            type="button"
            onClick={() => setFilter(b.key)}
            disabled={b.key !== "all" && c === 0}
            className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
              filter === b.key
                ? "bg-ink-900 text-white"
                : c === 0 && b.key !== "all"
                  ? "text-ink-300 cursor-not-allowed"
                  : "text-ink-600 hover:bg-ink-100"
            }`}
          >
            {b.label} <span className={filter === b.key ? "text-ink-300" : "text-ink-400"}>({c})</span>
          </button>
        );
      })}
    </div>
  );
}

function ResultRow({ result }: { result: SearchResult }) {
  const { state } = useSignal();
  const product = result.productId ? state.productsById[result.productId] : undefined;
  return (
    <li>
      <Link
        href={result.href}
        className="px-5 py-3 flex items-center gap-3 hover:bg-ink-50/60 transition-colors"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className={`badge ${entityTones[result.type]}`}>
              {entityLabels[result.type]}
            </span>
            {result.platform && result.platform !== "google" ? (
              <PlatformBadge platform={result.platform} />
            ) : result.platform === "google" ? (
              <span className="badge bg-ink-900 text-white">Google</span>
            ) : null}
            {product ? (
              <span className="text-xs text-ink-500">{product.name}</span>
            ) : null}
          </div>
          <div className="text-sm font-medium text-ink-900 truncate">
            {result.title}
          </div>
          {result.subtitle ? (
            <div className="text-xs text-ink-500 mt-0.5">{result.subtitle}</div>
          ) : null}
        </div>
        <ChevronRightIcon className="text-ink-400" />
      </Link>
    </li>
  );
}

function Hints() {
  return (
    <div className="card-padded text-sm text-ink-700 space-y-2 leading-relaxed">
      <div className="text-ink-900 font-medium">Try searching for:</div>
      <ul className="space-y-1 text-ink-700">
        <li>· A product name or domain (&quot;WebmasterID&quot;, &quot;cashworkspace.com&quot;)</li>
        <li>· An account handle (&quot;@webmasterid&quot;, &quot;u/wmi_observer&quot;)</li>
        <li>· A platform (&quot;reddit&quot;, &quot;linkedin&quot;)</li>
        <li>· A status (&quot;backlog&quot;, &quot;pending&quot;, &quot;warming&quot;)</li>
        <li>· An insight category (&quot;founder observation&quot;, &quot;support pattern&quot;)</li>
      </ul>
    </div>
  );
}

function hintFor(type: SearchEntityType): string {
  switch (type) {
    case "product":
      return "Products in this workspace.";
    case "account":
      return "Accounts across platforms.";
    case "weekly_item":
      return "Items in the current weekly plan.";
    case "backlog_item":
      return "Items currently held in the backlog.";
    case "insight":
      return "Source insights driving content opportunities.";
    case "content_asset":
      return "Discoverability assets (blog posts, guides, case studies).";
    case "risk":
      return "Open risk signals.";
    case "docs":
      return "Internal documentation surfaces.";
  }
}
