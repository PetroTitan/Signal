"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import { evaluateDiscussion } from "@/core/comment-intelligence";
import { discussionSeeds, sourceInsights } from "@/lib/mock";
import type {
  DiscussionOpportunity,
  ParticipationRecommendation,
} from "@/types";

const recommendationLabels: Record<ParticipationRecommendation, string> = {
  participate: "Participate",
  watch: "Watch",
  skip: "Skip",
};

const recommendationTones: Record<ParticipationRecommendation, string> = {
  participate: "bg-emerald-50 text-emerald-700",
  watch: "bg-signal-50 text-signal-700",
  skip: "bg-ink-100 text-ink-700",
};

export default function DiscussionsPage() {
  const { state } = useSignal();
  const [filter, setFilter] = useState<"all" | ParticipationRecommendation>(
    "all",
  );

  const evaluated = useMemo(() => {
    const products = Object.values(state.productsById);
    return discussionSeeds.map((seed) =>
      evaluateDiscussion({
        opportunity: seed,
        insights: sourceInsights,
        products,
      }),
    );
  }, [state.productsById]);

  const filtered = useMemo(() => {
    const sorted = [...evaluated].sort(
      (a, b) => b.participationScore - a.participationScore,
    );
    if (filter === "all") return sorted;
    return sorted.filter((d) => d.recommendation === filter);
  }, [evaluated, filter]);

  const counts = useMemo(() => {
    return {
      all: evaluated.length,
      participate: evaluated.filter((d) => d.recommendation === "participate").length,
      watch: evaluated.filter((d) => d.recommendation === "watch").length,
      skip: evaluated.filter((d) => d.recommendation === "skip").length,
    };
  }, [evaluated]);

  return (
    <>
      <Topbar
        title="Discussions"
        description="Where Signal recommends participating, watching, or skipping. Comments are first-class presence — not posting volume."
      />

      <div className="px-6 lg:px-8 py-6 max-w-7xl space-y-6">
        <Intro />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Total threads" value={counts.all} />
          <Stat label="Participate" value={counts.participate} tone="emerald" />
          <Stat label="Watch" value={counts.watch} tone="signal" />
          <Stat label="Skip" value={counts.skip} tone="ink" />
        </div>

        <FilterBar filter={filter} setFilter={setFilter} counts={counts} />

        {filtered.length === 0 ? (
          <div className="card-padded text-sm text-ink-500">
            Nothing in this view.
          </div>
        ) : (
          <ul className="space-y-3">
            {filtered.map((d) => (
              <DiscussionCard key={d.id} discussion={d} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Intro() {
  return (
    <div className="card border-signal-200 bg-signal-50/30 p-4 text-sm leading-relaxed">
      <div className="font-semibold text-ink-900 mb-1">
        Signal sometimes says &quot;skip this thread&quot;.
      </div>
      <p className="text-ink-700">
        Discussions are scored by community fit, audience match, freshness, and
        noise. The recommendation engine respects the rule that the best growth
        move is often non-participation. The threshold for &quot;participate&quot;
        is deliberately high.
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
  tone?: "emerald" | "signal" | "ink";
}) {
  const cls =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "signal"
        ? "text-signal-700"
        : tone === "ink"
          ? "text-ink-700"
          : "text-ink-900";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}

function FilterBar({
  filter,
  setFilter,
  counts,
}: {
  filter: "all" | ParticipationRecommendation;
  setFilter: (f: "all" | ParticipationRecommendation) => void;
  counts: Record<"all" | ParticipationRecommendation, number>;
}) {
  const buttons: { key: typeof filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "participate", label: "Participate" },
    { key: "watch", label: "Watch" },
    { key: "skip", label: "Skip" },
  ];
  return (
    <div className="card p-1.5 inline-flex flex-wrap gap-1">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={() => setFilter(b.key)}
          className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
            filter === b.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {b.label}{" "}
          <span className={filter === b.key ? "text-ink-300" : "text-ink-400"}>
            ({counts[b.key]})
          </span>
        </button>
      ))}
    </div>
  );
}

function DiscussionCard({
  discussion,
}: {
  discussion: DiscussionOpportunity;
}) {
  return (
    <li className="card">
      <header className="px-5 py-3 border-b border-ink-100 flex items-center gap-2 flex-wrap">
        <PlatformBadge platform={discussion.platform} />
        <span className="text-xs text-ink-500">{discussion.contextLabel}</span>
        <span className="text-xs text-ink-500">· {discussion.ageHours}h old</span>
        <span className="text-xs text-ink-500">
          · noise: {discussion.participation.noise}
        </span>
        <span className="text-xs text-ink-500">
          · freshness: {discussion.participation.freshness}
        </span>
        <span
          className={`badge ${recommendationTones[discussion.recommendation]} ml-auto`}
        >
          {recommendationLabels[discussion.recommendation]}
        </span>
      </header>
      <div className="px-5 py-4">
        <div className="text-sm font-semibold text-ink-900">
          {discussion.threadTitle}
        </div>
        <p className="text-xs text-ink-700 mt-1">{discussion.threadSummary}</p>
        <p className="text-xs text-ink-600 mt-1 italic">
          OP: {discussion.question}
        </p>

        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
          <SignalBlock
            label="Community fit"
            value={discussion.communityFit.level}
            detail={discussion.communityFit.reason}
          />
          <SignalBlock
            label="Audience match"
            value={discussion.participation.audienceMatch}
            detail={`${discussion.matchedInsightIds.length} insight match${discussion.matchedInsightIds.length === 1 ? "" : "es"}.`}
          />
        </div>

        <div className="mt-3 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <div className="text-ink-500">Participation score</div>
            <div className="font-medium text-ink-900">
              {discussion.participationScore}
            </div>
          </div>
          <div className="flex flex-wrap gap-1">
            {discussion.topicTags.slice(0, 5).map((tag) => (
              <span key={tag} className="badge-neutral text-[10px]">
                #{tag}
              </span>
            ))}
          </div>
        </div>

        {discussion.skipReason ? (
          <div className="mt-3 text-xs text-ink-700 italic">
            {discussion.skipReason}
          </div>
        ) : null}

        {discussion.recommendation !== "skip" ? (
          <div className="mt-3">
            <Link
              href="/comments"
              className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1"
            >
              Open comment drafts
              <ChevronRightIcon width={12} height={12} />
            </Link>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function SignalBlock({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md bg-ink-50/60 px-3 py-2">
      <div className="stat-label">{label}</div>
      <div className="text-sm font-medium text-ink-900 capitalize mt-0.5">
        {value.replace(/_/g, " ")}
      </div>
      <div className="text-[11px] text-ink-600 mt-1">{detail}</div>
    </div>
  );
}
