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

const recommendationTones: Record<ParticipationRecommendation, string> = {
  participate: "bg-emerald-50 text-emerald-700",
  watch: "bg-ink-100 text-ink-700",
  skip: "bg-ink-100 text-ink-500",
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

  return (
    <>
      <Topbar
        title="Discussions"
        description="Where to participate, where to watch, where to skip."
      />

      <div className="px-6 lg:px-10 py-8 space-y-6 max-w-4xl">
        <FilterBar
          filter={filter}
          setFilter={setFilter}
          all={evaluated.length}
          participate={evaluated.filter((d) => d.recommendation === "participate").length}
          watch={evaluated.filter((d) => d.recommendation === "watch").length}
          skip={evaluated.filter((d) => d.recommendation === "skip").length}
        />

        {filtered.length === 0 ? (
          <div className="text-sm text-ink-500 py-12 text-center">
            No discussions in this view.
          </div>
        ) : (
          <ul className="space-y-3">
            {filtered.map((d) => (
              <DiscussionRow key={d.id} discussion={d} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function FilterBar({
  filter,
  setFilter,
  all,
  participate,
  watch,
  skip,
}: {
  filter: "all" | ParticipationRecommendation;
  setFilter: (f: "all" | ParticipationRecommendation) => void;
  all: number;
  participate: number;
  watch: number;
  skip: number;
}) {
  const buttons: { key: typeof filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: all },
    { key: "participate", label: "Participate", count: participate },
    { key: "watch", label: "Watch", count: watch },
    { key: "skip", label: "Skip", count: skip },
  ];
  return (
    <div className="inline-flex flex-wrap gap-1">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={() => setFilter(b.key)}
          className={`text-xs px-3 py-1.5 rounded-md font-medium transition-colors ${
            filter === b.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {b.label}
          <span className={filter === b.key ? "text-ink-300 ml-1.5" : "text-ink-400 ml-1.5"}>
            {b.count}
          </span>
        </button>
      ))}
    </div>
  );
}

function DiscussionRow({ discussion }: { discussion: DiscussionOpportunity }) {
  return (
    <li className="card p-4">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <PlatformBadge platform={discussion.platform} />
        <span className="text-xs text-ink-500">{discussion.contextLabel}</span>
        <span className={`badge ${recommendationTones[discussion.recommendation]} ml-auto`}>
          {discussion.recommendation}
        </span>
      </div>
      <div className="text-sm font-medium text-ink-900 leading-snug">
        {discussion.threadTitle}
      </div>
      <p className="text-xs text-ink-600 mt-1.5 leading-relaxed">
        {discussion.threadSummary}
      </p>
      {discussion.skipReason ? (
        <p className="text-xs text-ink-500 mt-2 italic">{discussion.skipReason}</p>
      ) : null}
      {discussion.recommendation !== "skip" ? (
        <Link
          href="/comments"
          className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1 mt-3"
        >
          Open comment drafts
          <ChevronRightIcon width={12} height={12} />
        </Link>
      ) : null}
    </li>
  );
}
