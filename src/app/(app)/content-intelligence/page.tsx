"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import {
  buildDrafts,
  buildOpportunitiesForInsight,
  guardrailLabels,
  recentlyUsedHooks,
  summarizeMemory,
} from "@/core/content-intelligence";
import { sourceInsights } from "@/lib/mock";
import type {
  ContentOpportunity,
  DraftVariant,
  GuardrailFlag,
  SourceInsight,
} from "@/types";

const categoryLabels: Record<SourceInsight["category"], string> = {
  founder_observation: "Founder observation",
  product_lesson: "Product lesson",
  support_pattern: "Support pattern",
  workflow_problem: "Workflow problem",
  user_problem: "User problem",
  seo_opportunity: "SEO opportunity",
  discoverability_gap: "Discoverability gap",
  industry_pattern: "Industry pattern",
  operational_lesson: "Operational lesson",
  evergreen_topic: "Evergreen topic",
};

export default function ContentIntelligencePage() {
  const { state } = useSignal();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );
  const productsById = state.productsById;
  const knownHooks = useMemo(
    () => recentlyUsedHooks(state.items),
    [state.items],
  );
  const memory = useMemo(
    () =>
      summarizeMemory({
        insights: sourceInsights,
        items: state.items,
        weekStartIso: state.plan.weekStartIso,
      }),
    [state.items, state.plan.weekStartIso],
  );

  return (
    <>
      <Topbar
        title="Content intelligence"
        description="Signal builds platform-native opportunities from insights, not from posting volume."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <Intro />

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label="Insights" value={memory.totalInsights} />
          <Stat
            label="Used this week"
            value={memory.usedThisWeek}
            sub={`${Math.max(0, memory.totalInsights - memory.usedThisWeek)} untapped`}
          />
          <Stat label="Evergreen available" value={memory.evergreenAvailable} tone="emerald" />
          <Stat label="Underused" value={memory.underused} />
          <Stat label="Stale" value={memory.stale} tone={memory.stale > 0 ? "amber" : undefined} />
          <Stat
            label="Repeated hooks"
            value={memory.repeatedHooks.length}
            tone={memory.repeatedHooks.length > 0 ? "amber" : undefined}
          />
        </div>

        <RepeatedHooks repeated={memory.repeatedHooks} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <InsightLibrary
              insights={sourceInsights}
              productsById={productsById}
            />
            <DraftPipeline
              insights={sourceInsights}
              products={products}
              productsById={productsById}
              knownHooks={knownHooks}
            />
          </div>
          <div className="space-y-6">
            <PipelineBridge />
            <GuardrailLegend />
          </div>
        </div>
      </div>
    </>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        Insight-first content intelligence.
      </div>
      <p className="text-ink-700">
        Signal does not generate posting volume. It transforms founder
        observations, product lessons, and support patterns into platform-native
        opportunities. Each insight produces calm draft variants per platform,
        with deterministic guardrails that flag aggressive CTAs, repeated hooks,
        launch-spam language, and AI-voice phrasing before anything reaches the
        approval queue.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: "emerald" | "amber";
}) {
  const cls =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : "text-ink-900";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${cls}`}>{value}</div>
      {sub ? <div className="text-[11px] text-ink-500 mt-0.5">{sub}</div> : null}
    </div>
  );
}

function RepeatedHooks({
  repeated,
}: {
  repeated: { hook: string; count: number }[];
}) {
  if (repeated.length === 0) return null;
  return (
    <section className="card border-amber-200 bg-amber-50/40">
      <header className="px-5 py-3.5 border-b border-amber-200">
        <div className="text-sm font-semibold text-ink-900">
          Repeated hooks in the current plan
        </div>
        <p className="text-xs text-ink-600 mt-0.5">
          Hooks that show up more than once. Soften or rewrite before publishing.
        </p>
      </header>
      <ul className="row-divider">
        {repeated.map((r) => (
          <li key={r.hook} className="px-5 py-2.5 flex items-center justify-between">
            <span className="text-sm text-ink-900">{r.hook}</span>
            <span className="text-xs text-ink-500">{r.count}×</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InsightLibrary({
  insights,
  productsById,
}: {
  insights: SourceInsight[];
  productsById: Record<string, { id: string; name: string }>;
}) {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Source insights
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Operational observations, lessons, and patterns from across the
          portfolio. Insights drive opportunities, not the other way around.
        </p>
      </header>
      <ul className="row-divider">
        {insights.map((insight) => (
          <li key={insight.id} className="px-5 py-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="badge-neutral">
                    {categoryLabels[insight.category]}
                  </span>
                  <span className="text-xs text-ink-500">
                    {productsById[insight.productId]?.name}
                  </span>
                </div>
                <div className="text-sm font-medium text-ink-900">
                  {insight.title}
                </div>
                <p className="text-xs text-ink-700 mt-1">{insight.coreInsight}</p>
                <div className="flex items-center gap-3 text-[11px] text-ink-500 mt-2">
                  <span>conv {insight.conversationScore}</span>
                  <span>evergreen {insight.evergreenScore}</span>
                  <span>discover {insight.discoverabilityPotential}</span>
                  <span>freshness {insight.freshnessPotential}</span>
                </div>
              </div>
              <PlatformFitChips fit={insight.platformFit} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlatformFitChips({
  fit,
}: {
  fit: SourceInsight["platformFit"];
}) {
  const labels: { key: keyof SourceInsight["platformFit"]; label: string }[] = [
    { key: "reddit", label: "Reddit" },
    { key: "x", label: "X" },
    { key: "linkedin", label: "LinkedIn" },
    { key: "google", label: "Google" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((l) => {
        const level = fit[l.key];
        if (level === "none") {
          return (
            <span
              key={l.key}
              className="badge bg-ink-100 text-ink-400 text-[10px]"
            >
              {l.label}: —
            </span>
          );
        }
        const tone =
          level === "strong"
            ? "bg-emerald-50 text-emerald-700"
            : level === "medium"
              ? "bg-signal-50 text-signal-700"
              : "bg-ink-100 text-ink-700";
        return (
          <span key={l.key} className={`badge ${tone} text-[10px]`}>
            {l.label}: {level}
          </span>
        );
      })}
    </div>
  );
}

function DraftPipeline({
  insights,
  products,
  productsById,
  knownHooks,
}: {
  insights: SourceInsight[];
  products: { id: string; name: string }[];
  productsById: Record<string, { id: string; name: string }>;
  knownHooks: string[];
}) {
  const rows = useMemo(() => {
    const items: {
      insight: SourceInsight;
      opportunities: ContentOpportunity[];
      drafts: DraftVariant[];
    }[] = [];
    for (const insight of insights.slice(0, 4)) {
      const product = products.find((p) => p.id === insight.productId);
      if (!product) continue;
      const opps = buildOpportunitiesForInsight({
        insight,
        product: product as Parameters<typeof buildOpportunitiesForInsight>[0]["product"],
      });
      const drafts: DraftVariant[] = [];
      for (const opp of opps) {
        if (opp.channel === "google") continue;
        drafts.push(
          ...buildDrafts({
            opportunity: opp,
            insight,
            product: product as Parameters<typeof buildDrafts>[0]["product"],
            knownHooks,
          }),
        );
      }
      items.push({ insight, opportunities: opps, drafts });
    }
    return items;
  }, [insights, products, knownHooks]);

  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Draft pipeline</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Each insight produces platform-specific opportunities and calm draft
          variants. Guardrail flags surface here before drafts reach the
          approval queue.
        </p>
      </header>
      <ul className="row-divider">
        {rows.map(({ insight, opportunities, drafts }) => (
          <li key={insight.id} className="px-5 py-4">
            <div className="text-sm font-semibold text-ink-900">
              {insight.title}
            </div>
            <div className="text-[11px] text-ink-500 mt-0.5">
              {productsById[insight.productId]?.name} · {opportunities.length}{" "}
              opportunities · {drafts.length} draft variants
            </div>
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
              {drafts.slice(0, 4).map((d) => (
                <DraftCard key={d.id} draft={d} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DraftCard({ draft }: { draft: DraftVariant }) {
  return (
    <div className="rounded-md border border-ink-100 bg-white p-3">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <PlatformBadge platform={draft.platform} />
        <span className="text-[11px] text-ink-500 capitalize">
          {draft.kind.replace(/_/g, " ")}
        </span>
        <span className="text-[11px] text-ink-400">·</span>
        <span className="text-[11px] text-ink-500">
          tone: {draft.toneStrength}
        </span>
        <span className="text-[11px] text-ink-500">
          · CTA: {draft.ctaIntensity}
        </span>
      </div>
      <div className="text-sm font-medium text-ink-900">{draft.hook}</div>
      <p className="text-xs text-ink-700 mt-1 whitespace-pre-line line-clamp-5">
        {draft.body}
      </p>
      {draft.cta ? (
        <p className="text-[11px] text-ink-500 mt-1">CTA: {draft.cta}</p>
      ) : null}
      {draft.guardrailFlags.length > 0 ? (
        <GuardrailFlags flags={draft.guardrailFlags} />
      ) : (
        <div className="text-[11px] text-emerald-700 mt-2">
          ✓ Passes guardrails
        </div>
      )}
    </div>
  );
}

function GuardrailFlags({ flags }: { flags: GuardrailFlag[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {flags.map((flag) => (
        <span
          key={flag}
          className="inline-flex items-center text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded"
        >
          {guardrailLabels[flag]}
        </span>
      ))}
    </div>
  );
}

function PipelineBridge() {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Where this connects
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          The intelligence layer flows into approval, scheduling, and the
          discoverability dashboard.
        </p>
      </header>
      <ul className="row-divider text-sm">
        {[
          { href: "/opportunities", label: "Opportunities", hint: "All channels" },
          {
            href: "/discussions",
            label: "Discussions",
            hint: "Reddit, X, LinkedIn participation",
          },
          { href: "/comments", label: "Comments", hint: "Reply + comment drafts" },
          { href: "/approval-queue", label: "Approval queue", hint: "Weekly review" },
          {
            href: "/discoverability",
            label: "Discoverability",
            hint: "Search-to-social loop",
          },
        ].map((row) => (
          <li key={row.href}>
            <Link
              href={row.href}
              className="px-5 py-2.5 flex items-center justify-between hover:bg-ink-50/60 transition-colors"
            >
              <div>
                <div className="text-ink-900">{row.label}</div>
                <div className="text-[11px] text-ink-500">{row.hint}</div>
              </div>
              <ChevronRightIcon className="text-ink-400" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function GuardrailLegend() {
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Quality guardrails
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Every draft is scanned for these patterns. Signal flags before
          approving — it does not block the founder, it just surfaces.
        </p>
      </header>
      <ul className="px-5 py-3 text-xs text-ink-700 space-y-1">
        {(Object.keys(guardrailLabels) as GuardrailFlag[]).map((f) => (
          <li key={f}>
            <span className="text-ink-500 mr-2">·</span>
            {guardrailLabels[f]}
          </li>
        ))}
      </ul>
    </section>
  );
}
