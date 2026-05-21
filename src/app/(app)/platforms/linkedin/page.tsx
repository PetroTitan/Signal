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
import type { WeeklyPlanItem } from "@/types";

export default function LinkedInCommandCenter() {
  const { state } = useSignal();
  const items = useMemo(
    () => state.items.filter((i) => i.platform === "linkedin"),
    [state.items],
  );

  return (
    <>
      <Topbar
        title="LinkedIn command center"
        description="B2B trust layer. Quality over frequency. Founder credibility comes first."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <StrategyHeader platform="linkedin" />
        <PlatformStats platform="linkedin" />
        <RecommendationsCallout platform="linkedin" />

        <PolishChecklist items={items} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <AccountsForPlatform platform="linkedin" />
            <ContentQueueForPlatform platform="linkedin" />
            <RiskRulesList platform="linkedin" />
          </div>
          <div className="space-y-6">
            <PlaybookGrid platform="linkedin" />
            <OpportunitiesList platform="linkedin" />
            <ContentFormatsList platform="linkedin" />
            <AnalyticsPlaceholder platform="linkedin" />
            <OAuthFutureCard platform="linkedin" />
          </div>
        </div>
      </div>
    </>
  );
}

function PolishChecklist({ items }: { items: WeeklyPlanItem[] }) {
  const longform = items.filter(
    (i) =>
      i.contentType === "long_form_article" || i.contentType === "case_study",
  );
  const blockedOrHigh = items.filter(
    (i) => i.risk.level === "blocked" || i.risk.level === "high",
  );
  const promo = items.filter((i) => i.draft.trackingLinkId).length;
  const replies = items.filter((i) => i.contentType === "comment_reply").length;

  const checks: { label: string; ok: boolean; detail: string }[] = [
    {
      label: "Has at least one long-form item this week",
      ok: longform.length > 0,
      detail:
        longform.length > 0
          ? `${longform.length} long-form / case study item${longform.length === 1 ? "" : "s"} scheduled.`
          : "Add a founder essay or case study to anchor the week.",
    },
    {
      label: "Promotional rhythm under one per account",
      ok: promo <= 1,
      detail:
        promo <= 1
          ? "Healthy. Trust layer breathes."
          : `${promo} promotional posts scheduled — consider moving extras to the backlog.`,
    },
    {
      label: "No high-risk or blocked items",
      ok: blockedOrHigh.length === 0,
      detail:
        blockedOrHigh.length === 0
          ? "Risk engine is clear for LinkedIn this week."
          : `${blockedOrHigh.length} item${blockedOrHigh.length === 1 ? "" : "s"} need attention in the risk center.`,
    },
    {
      label: "Comments on industry posts planned",
      ok: replies >= 1,
      detail:
        replies >= 1
          ? `${replies} thoughtful-comment item${replies === 1 ? "" : "s"} scheduled.`
          : "Add at least one industry-comment item per active account.",
    },
  ];

  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          Polish checklist
        </div>
        <p className="text-xs text-ink-500 mt-0.5">
          LinkedIn rewards structure. These checks summarize whether the week
          meets B2B-grade quality bar.
        </p>
      </header>
      <ul className="row-divider">
        {checks.map((c) => (
          <li key={c.label} className="px-5 py-3 flex items-start gap-3">
            <span
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full mt-0.5 shrink-0 ${
                c.ok
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              {c.ok ? "✓" : "!"}
            </span>
            <div>
              <div className="text-sm text-ink-900 font-medium">{c.label}</div>
              <div className="text-xs text-ink-600 mt-0.5">{c.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
