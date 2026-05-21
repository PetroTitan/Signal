"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { useSignal } from "@/core/store";
import {
  buildCommentDrafts,
  buildReplyDrafts,
  evaluateDiscussion,
} from "@/core/comment-intelligence";
import { guardrailLabels } from "@/core/content-intelligence";
import { discussionSeeds, sourceInsights } from "@/lib/mock";
import type {
  CommentDraft,
  ConversationRiskLevel,
  DiscussionOpportunity,
  GuardrailFlag,
  PlatformId,
  ReplyDraft,
} from "@/types";

const riskTones: Record<ConversationRiskLevel, string> = {
  low: "badge-low",
  medium: "badge-medium",
  high: "badge-high",
  blocked: "badge bg-ink-900 text-white",
};

export default function CommentsPage() {
  const { state } = useSignal();
  const [platform, setPlatform] = useState<"all" | PlatformId>("all");

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

  const drafts = useMemo(() => {
    const knownBodies: string[] = [];
    const rows: {
      opportunity: DiscussionOpportunity;
      comments: CommentDraft[];
      replies: ReplyDraft[];
    }[] = [];
    for (const opp of evaluated) {
      const comments = buildCommentDrafts({
        opportunity: opp,
        insights: sourceInsights,
        knownBodies,
      });
      const replies = buildReplyDrafts({
        opportunity: opp,
        insights: sourceInsights,
        knownBodies,
      });
      for (const c of comments) knownBodies.push(c.body);
      for (const r of replies) knownBodies.push(r.body);
      if (comments.length === 0 && replies.length === 0) continue;
      rows.push({ opportunity: opp, comments, replies });
    }
    return rows;
  }, [evaluated]);

  const filtered = useMemo(() => {
    if (platform === "all") return drafts;
    return drafts.filter((d) => d.opportunity.platform === platform);
  }, [drafts, platform]);

  const totalDrafts = useMemo(
    () =>
      drafts.reduce((sum, d) => sum + d.comments.length + d.replies.length, 0),
    [drafts],
  );

  return (
    <>
      <Topbar
        title="Comments"
        description="Calm, contextual comment and reply drafts produced from matched insights. Nothing publishes automatically."
      />

      <div className="px-6 lg:px-8 py-6 max-w-6xl space-y-6">
        <Intro />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Threads with drafts" value={drafts.length} />
          <Stat label="Total drafts" value={totalDrafts} />
          <Stat
            label="Skipped threads"
            value={evaluated.length - drafts.length}
            tone="ink"
          />
          <Stat label="Insights in library" value={sourceInsights.length} />
        </div>

        <PlatformFilter value={platform} onChange={setPlatform} />

        {filtered.length === 0 ? (
          <div className="card-padded text-sm text-ink-500">
            No drafts for this platform yet — discussion engine recommends skipping
            or watching every thread on this surface.
          </div>
        ) : (
          <ul className="space-y-4">
            {filtered.map((row) => (
              <CommentThread key={row.opportunity.id} row={row} />
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
        Comments are participation, not output.
      </div>
      <p className="text-ink-700">
        Signal builds calm comment and reply drafts only when a discussion
        matches a real insight. Generic agreement, executive clichés, and
        engagement bait are scored by the conversation risk layer and blocked
        before reaching the approval queue.
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
  tone?: "ink";
}) {
  const cls = tone === "ink" ? "text-ink-700" : "text-ink-900";
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${cls}`}>{value}</div>
    </div>
  );
}

function PlatformFilter({
  value,
  onChange,
}: {
  value: "all" | PlatformId;
  onChange: (v: "all" | PlatformId) => void;
}) {
  const buttons: { key: typeof value; label: string }[] = [
    { key: "all", label: "All" },
    { key: "reddit", label: "Reddit" },
    { key: "x", label: "X" },
    { key: "linkedin", label: "LinkedIn" },
  ];
  return (
    <div className="card p-1.5 inline-flex flex-wrap gap-1">
      {buttons.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={() => onChange(b.key)}
          className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
            value === b.key
              ? "bg-ink-900 text-white"
              : "text-ink-600 hover:bg-ink-100"
          }`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

function CommentThread({
  row,
}: {
  row: {
    opportunity: DiscussionOpportunity;
    comments: CommentDraft[];
    replies: ReplyDraft[];
  };
}) {
  return (
    <li className="card">
      <header className="px-5 py-3 border-b border-ink-100 flex items-center gap-2 flex-wrap">
        <PlatformBadge platform={row.opportunity.platform} />
        <span className="text-xs text-ink-500">
          {row.opportunity.contextLabel}
        </span>
        <span className="text-xs text-ink-500">
          · score {row.opportunity.participationScore}
        </span>
        <span className="text-xs text-ink-500">
          · {row.opportunity.recommendation}
        </span>
      </header>
      <div className="px-5 py-4 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">
          {row.opportunity.threadTitle}
        </div>
        <p className="text-xs text-ink-600 mt-1">{row.opportunity.threadSummary}</p>
        <p className="text-xs text-ink-700 mt-1 italic">
          OP: {row.opportunity.question}
        </p>
      </div>
      <ul className="row-divider">
        {row.comments.map((c) => (
          <DraftRow
            key={c.id}
            body={c.body}
            risk={c.risk.level}
            recommendation={c.risk.recommendation}
            flags={c.guardrailFlags}
            label="Comment"
            tone={c.toneStrength}
          />
        ))}
        {row.replies.map((r) => (
          <DraftRow
            key={r.id}
            body={r.body}
            risk={r.risk.level}
            recommendation={r.risk.recommendation}
            flags={r.guardrailFlags}
            label="Reply"
            tone={r.toneStrength}
          />
        ))}
      </ul>
    </li>
  );
}

function DraftRow({
  body,
  risk,
  recommendation,
  flags,
  label,
  tone,
}: {
  body: string;
  risk: ConversationRiskLevel;
  recommendation: string;
  flags: GuardrailFlag[];
  label: "Comment" | "Reply";
  tone: "calm" | "moderate";
}) {
  return (
    <li className="px-5 py-3.5">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className="badge-neutral">{label}</span>
        <span className="text-[11px] text-ink-500">tone: {tone}</span>
        <span className={riskTones[risk]}>{risk}</span>
      </div>
      <p className="text-sm text-ink-800 whitespace-pre-line leading-relaxed">
        {body}
      </p>
      {flags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {flags.map((f) => (
            <span
              key={f}
              className="inline-flex items-center text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded"
            >
              {guardrailLabels[f]}
            </span>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-ink-600 mt-2 italic">{recommendation}</p>
    </li>
  );
}
