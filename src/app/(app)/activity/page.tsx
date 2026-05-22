"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { EmptyState } from "@/components/empty-state";
import { SectionHeader } from "@/components/section-header";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import { deriveActivity, deriveDiscussionActivity } from "@/core/activity";
import { evaluateDiscussion } from "@/core/comment-intelligence";
import {
  contentAssets as allContentAssets,
  discussionSeeds as allDiscussionSeeds,
  riskEvents as allRiskEvents,
  sourceInsights as allSourceInsights,
} from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";
import { formatDateTime, relativeFromNow } from "@/lib/format";
import type {
  ActivityEvent,
  ActivityLayer,
  ActivitySeverity,
} from "@/types";

type LayerFilter = "all" | ActivityLayer;
type SeverityFilter = "all" | ActivitySeverity;

const layerLabels: Record<ActivityLayer, string> = {
  core: "Core",
  platform_social: "Social",
  platform_search: "Search",
  intelligence: "Intelligence",
  operations: "Operations",
  configuration: "Configuration",
};

const layerTones: Record<ActivityLayer, string> = {
  core: "bg-ink-100 text-ink-700",
  platform_social: "bg-signal-50 text-signal-700",
  platform_search: "bg-ink-900 text-white",
  intelligence: "bg-emerald-50 text-emerald-700",
  operations: "bg-amber-50 text-amber-700",
  configuration: "bg-ink-100 text-ink-700",
};

const severityTones: Record<ActivitySeverity, string> = {
  info: "bg-ink-100 text-ink-700",
  ok: "badge-low",
  warn: "badge-medium",
  block: "badge-high",
};

export default function ActivityPage() {
  const { state } = useSignal();
  const [layer, setLayer] = useState<LayerFilter>("all");
  const [severity, setSeverity] = useState<SeverityFilter>("all");

  const sourceInsights = useDemoData(allSourceInsights);
  const discussionSeeds = useDemoData(allDiscussionSeeds);
  const contentAssets = useDemoData(allContentAssets);
  const riskEvents = useDemoData(allRiskEvents);

  const events = useMemo(() => {
    const products = Object.values(state.productsById);
    const evaluatedDiscussions = discussionSeeds.map((seed) =>
      evaluateDiscussion({
        opportunity: seed,
        insights: sourceInsights,
        products,
      }),
    );
    const base = deriveActivity({
      plan: state.plan,
      items: state.items,
      backlog: state.backlog,
      approvalEvents: state.approvalEvents,
      accountsById: state.accountsById,
      productsById: state.productsById,
      riskEvents,
      contentAssets,
      insights: sourceInsights,
      lastMoves: state.lastMoves,
    });
    const discussions = deriveDiscussionActivity({
      discussionOpportunities: evaluatedDiscussions,
    });
    return [...base, ...discussions].sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }, [
    sourceInsights,
    discussionSeeds,
    contentAssets,
    riskEvents,
    state.plan,
    state.items,
    state.backlog,
    state.approvalEvents,
    state.accountsById,
    state.productsById,
    state.lastMoves,
  ]);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (layer !== "all" && e.layer !== layer) return false;
      if (severity !== "all" && e.severity !== severity) return false;
      return true;
    });
  }, [events, layer, severity]);

  const counts = useMemo(() => {
    return {
      total: events.length,
      block: events.filter((e) => e.severity === "block").length,
      warn: events.filter((e) => e.severity === "warn").length,
      info: events.filter((e) => e.severity === "info").length,
      ok: events.filter((e) => e.severity === "ok").length,
    };
  }, [events]);

  return (
    <>
      <Topbar
        title="Activity"
        description="Internal operational timeline. Every event is derived from current state, not from fake analytics."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <Intro />

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="All events" value={counts.total} />
          <Stat label="Blocked" value={counts.block} tone="block" />
          <Stat label="Warn" value={counts.warn} tone="warn" />
          <Stat label="Info" value={counts.info} />
          <Stat label="OK" value={counts.ok} tone="ok" />
        </div>

        <div className="flex flex-wrap gap-3">
          <FilterChips
            label="Layer"
            value={layer}
            options={[
              { key: "all", label: "All" },
              { key: "core", label: "Core" },
              { key: "operations", label: "Operations" },
              { key: "intelligence", label: "Intelligence" },
              { key: "platform_social", label: "Social" },
              { key: "platform_search", label: "Search" },
              { key: "configuration", label: "Config" },
            ]}
            onChange={(v) => setLayer(v as LayerFilter)}
          />
          <FilterChips
            label="Severity"
            value={severity}
            options={[
              { key: "all", label: "All" },
              { key: "block", label: "Blocked" },
              { key: "warn", label: "Warn" },
              { key: "info", label: "Info" },
              { key: "ok", label: "OK" },
            ]}
            onChange={(v) => setSeverity(v as SeverityFilter)}
          />
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            title="No events match these filters"
            description="Clear filters or wait for new operational activity from the engines."
          />
        ) : (
          <section className="card">
            <SectionHeader
              title={`${filtered.length} event${filtered.length === 1 ? "" : "s"}`}
              hint="Most recent first."
            />
            <ul className="row-divider">
              {filtered.slice(0, 80).map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        The internal timeline.
      </div>
      <p className="text-ink-700">
        Signal&apos;s activity timeline is computed from the live state: every
        insight, account, draft, approval, redistribution, risk signal,
        discoverability opportunity, and skipped discussion is a deterministic
        event. Nothing here is performance data. When platform APIs ship,
        external events will join the same stream.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "block" | "warn" | "ok";
}) {
  const cls =
    tone === "block"
      ? "text-red-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "ok"
          ? "text-emerald-700"
          : "text-ink-900";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}

function FilterChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="card p-1.5 inline-flex flex-wrap gap-1">
      <span className="text-[10px] text-ink-500 uppercase tracking-wide self-center px-1.5">
        {label}
      </span>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
            value === o.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const { state } = useSignal();
  const product = event.productId ? state.productsById[event.productId] : undefined;
  return (
    <li className="px-5 py-3 flex items-start gap-4">
      <div className="text-[11px] text-ink-500 font-mono w-36 shrink-0 leading-tight">
        <div>{formatDateTime(event.occurredAt)}</div>
        <div className="text-ink-400">{relativeFromNow(event.occurredAt)}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className={`badge ${layerTones[event.layer]}`}>
            {layerLabels[event.layer]}
          </span>
          <span className={`badge ${severityTones[event.severity]}`}>
            {event.severity}
          </span>
          {event.platform && event.platform !== "google" ? (
            <PlatformBadge platform={event.platform} />
          ) : event.platform === "google" ? (
            <span className="badge bg-ink-900 text-white">Google</span>
          ) : null}
          {product ? (
            <span className="text-xs text-ink-500">{product.name}</span>
          ) : null}
        </div>
        <div className="text-sm font-medium text-ink-900">{event.title}</div>
        <p className="text-xs text-ink-700 mt-0.5">{event.explanation}</p>
      </div>
      {event.link ? (
        <Link
          href={event.link}
          className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1 shrink-0"
        >
          Open
          <ChevronRightIcon width={12} height={12} />
        </Link>
      ) : null}
    </li>
  );
}
