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
  PlatformStats,
  PlaybookGrid,
  RecommendationsCallout,
  RiskRulesList,
  StrategyHeader,
} from "@/components/command-center";
import { useSignal } from "@/core/store";

export default function RedditCommandCenter() {
  const { state } = useSignal();
  const items = useMemo(
    () => state.items.filter((i) => i.platform === "reddit"),
    [state.items],
  );

  const comments = items.filter((i) => i.contentType === "comment_reply");
  const discussions = items.filter(
    (i) =>
      i.contentType === "discussion_post" || i.contentType === "tutorial",
  );
  const promo = items.filter(
    (i) => i.draft.trackingLinkId || i.draft.cta,
  );
  const ratio =
    items.length === 0
      ? 0
      : Math.round((comments.length / items.length) * 100);

  return (
    <>
      <Topbar
        title="Reddit command center"
        description="Community-first. Comments before posts. Links last."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <StrategyHeader platform="reddit" />
        <PlatformStats platform="reddit" />

        <RedditRatioPanel
          comments={comments.length}
          discussions={discussions.length}
          promo={promo.length}
          ratio={ratio}
        />

        <RecommendationsCallout platform="reddit" />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <AccountsForPlatform platform="reddit" />
            <ContentQueueForPlatform platform="reddit" />
            <RiskRulesList platform="reddit" />
          </div>
          <div className="space-y-6">
            <PlaybookGrid platform="reddit" />
            <OpportunitiesList platform="reddit" />
            <ContentFormatsList platform="reddit" />
            <AnalyticsPlaceholder platform="reddit" />
            <OAuthFutureCard platform="reddit" />
          </div>
        </div>
      </div>
    </>
  );
}

function RedditRatioPanel({
  comments,
  discussions,
  promo,
  ratio,
}: {
  comments: number;
  discussions: number;
  promo: number;
  ratio: number;
}) {
  const healthy = ratio >= 60;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Comments-first ratio
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          Reddit cadence rewards accounts that comment more than they post.
          Aim for 60% or more of weekly items to be comments.
        </p>
      </header>
      <div className="px-5 py-4 space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Tile label="Comments" value={comments} tone="emerald" />
          <Tile label="Discussion posts" value={discussions} />
          <Tile
            label="Direct-link items"
            value={promo}
            tone={promo > 1 ? "amber" : undefined}
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1 text-xs">
            <span className="text-ink-500">Comments-first ratio</span>
            <span
              className={`font-medium ${healthy ? "text-emerald-700" : "text-amber-700"}`}
            >
              {ratio}%
            </span>
          </div>
          <div className="h-2 bg-ink-100 rounded-full overflow-hidden">
            <div
              className={`h-full ${healthy ? "bg-emerald-500" : "bg-amber-500"}`}
              style={{ width: `${ratio}%` }}
            />
          </div>
          <p className="text-[11px] text-ink-500 mt-1.5">
            {healthy
              ? "Looks healthy. Keep comments leading."
              : "Below 60%. Add more comment-type items or move a post to the backlog."}
          </p>
        </div>
      </div>
    </section>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "amber";
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
    </div>
  );
}
