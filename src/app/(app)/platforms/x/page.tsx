"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import {
  AccountsForPlatform,
  AnalyticsPlaceholder,
  ContentFormatsList,
  ContentQueueForPlatform,
  OAuthFutureCard,
  OpportunitiesList,
  PlatformNotConnectedPanel,
  PlatformStats,
  PlaybookGrid,
  RecommendationsCallout,
  RiskRulesList,
  StrategyHeader,
} from "@/components/command-center";
import { DemoLabel } from "@/components/empty-state";
import { useSignal } from "@/core/store";
import { useDataMode } from "@/core/data-mode";
import { accountWeeklyCount } from "@/core/scheduler";
import { getPlatformCadencePolicy } from "@/core/platforms";

export default function XCommandCenter() {
  const { state } = useSignal();
  const dataMode = useDataMode();
  const accounts = useMemo(
    () =>
      Object.values(state.accountsById).filter((a) => a.platform === "x"),
    [state.accountsById],
  );
  const items = useMemo(
    () => state.items.filter((i) => i.platform === "x"),
    [state.items],
  );

  const replies = items.filter((i) => i.contentType === "comment_reply");
  const threads = items.filter((i) => i.contentType === "thread");
  const shorts = items.filter((i) => i.contentType === "discussion_post");
  const longform = items.filter(
    (i) =>
      i.contentType === "announcement" || i.contentType === "case_study",
  );

  if (!dataMode.isDemo && accounts.length === 0 && items.length === 0) {
    return (
      <>
        <Topbar
          title="X command center"
          description="Founder voice. Replies first. Threads when they matter."
        />
        <div className="px-6 lg:px-8 py-8 max-w-7xl">
          <PlatformNotConnectedPanel platform="x" />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="X command center"
        description="Founder voice. Replies first. Threads when they matter."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        {dataMode.isDemo ? <DemoLabel /> : null}
        <StrategyHeader platform="x" />
        <PlatformStats platform="x" />
        <RecommendationsCallout platform="x" />

        <FormatMix
          replies={replies.length}
          threads={threads.length}
          shorts={shorts.length}
          longform={longform.length}
        />

        <VelocityPanel accounts={accounts} items={items} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <AccountsForPlatform platform="x" />
            <ContentQueueForPlatform platform="x" />
            <RiskRulesList platform="x" />
          </div>
          <div className="space-y-6">
            <PlaybookGrid platform="x" />
            <OpportunitiesList platform="x" />
            <ContentFormatsList platform="x" />
            <AnalyticsPlaceholder platform="x" />
            <OAuthFutureCard platform="x" />
          </div>
        </div>
      </div>
    </>
  );
}

function FormatMix({
  replies,
  threads,
  shorts,
  longform,
}: {
  replies: number;
  threads: number;
  shorts: number;
  longform: number;
}) {
  const total = replies + threads + shorts + longform;
  const tiles = [
    { label: "Replies", value: replies, tone: "emerald" as const },
    { label: "Short posts", value: shorts },
    { label: "Threads", value: threads, tone: threads > 2 ? ("amber" as const) : undefined },
    { label: "Long-form / story", value: longform },
  ];
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Format mix</div>
        <p className="text-xs text-ink-500 mt-0.5">
          On X, replies are first-class presence. Threads stay deliberate.
        </p>
      </header>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
        {tiles.map((t) => (
          <Mini key={t.label} {...t} totalLabel={`${total} items`} />
        ))}
      </div>
      {total === 0 ? (
        <div className="px-5 py-3 text-sm text-ink-500 border-t border-ink-100">
          Nothing scheduled for X this week.
        </div>
      ) : null}
    </section>
  );
}

function Mini({
  label,
  value,
  tone,
  totalLabel,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber";
  totalLabel: string;
}) {
  const toneClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : "text-ink-900";
  return (
    <div className="rounded-md bg-ink-50/70 px-3 py-2">
      <div className="stat-label">{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${toneClass}`}>{value}</div>
      <div className="text-[11px] text-ink-500">of {totalLabel}</div>
    </div>
  );
}

function VelocityPanel({
  accounts,
  items,
}: {
  accounts: ReturnType<typeof useSignal>["state"]["accountsById"][string][];
  items: ReturnType<typeof useSignal>["state"]["items"];
}) {
  const cadence = getPlatformCadencePolicy("x");
  if (accounts.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Account velocity
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Per-account weekly count vs. suggested cadence ({cadence.suggestedPostsPerWeek}/week).
        </p>
      </header>
      <ul className="row-divider">
        {accounts.map((a) => {
          const count = accountWeeklyCount(a.id, items);
          const pct = Math.min(
            100,
            Math.round((count / cadence.maxPostsPerWeek) * 100),
          );
          const over = count > cadence.suggestedPostsPerWeek;
          return (
            <li key={a.id} className="px-5 py-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-sm text-ink-900">{a.displayName}</div>
                <div className="text-xs text-ink-500">
                  {count} / {cadence.suggestedPostsPerWeek} suggested · cap {cadence.maxPostsPerWeek}
                </div>
              </div>
              <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden">
                <div
                  className={`h-full ${over ? "bg-amber-500" : "bg-signal-500"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {over ? (
                <div className="text-[11px] text-amber-700 mt-1">
                  Over suggested. Slow this account next week.
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
