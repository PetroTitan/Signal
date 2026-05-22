"use client";

import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { PlatformBadge } from "@/components/badges";
import { DemoLabel, NotConnectedState } from "@/components/empty-state";
import { useSignal } from "@/core/store";
import { useDataMode } from "@/core/data-mode";
import {
  buildCommentDrafts,
  buildReplyDrafts,
  evaluateDiscussion,
} from "@/core/comment-intelligence";
import {
  discussionSeeds as allDiscussionSeeds,
  sourceInsights as allSourceInsights,
} from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";
import type {
  CommentDraft,
  ConversationRiskLevel,
  DiscussionOpportunity,
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
  const dataMode = useDataMode();

  const discussionSeeds = useDemoData(allDiscussionSeeds);
  const sourceInsights = useDemoData(allSourceInsights);

  const drafts = useMemo(() => {
    const products = Object.values(state.productsById);
    const evaluated = discussionSeeds.map((seed) =>
      evaluateDiscussion({
        opportunity: seed,
        insights: sourceInsights,
        products,
      }),
    );
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
  }, [state.productsById, discussionSeeds, sourceInsights]);

  if (!dataMode.isDemo && discussionSeeds.length === 0 && !dataMode.hasAccounts) {
    return (
      <>
        <Topbar
          title="Comments"
          description="Drafts ready for review once accounts are connected."
        />
        <div className="px-6 lg:px-10 py-8 max-w-3xl">
          <NotConnectedState variant="noPlatformActivity" />
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Comments"
        description="Drafts ready for review. Each one is grounded in an insight."
      />

      <div className="px-6 lg:px-10 py-8 space-y-4 max-w-4xl">
        {dataMode.isDemo ? <DemoLabel /> : null}
        {drafts.length === 0 ? (
          <div className="text-sm text-ink-500 py-12 text-center">
            No drafts. Open discussions to see where to participate.
          </div>
        ) : (
          <ul className="space-y-4">
            {drafts.map((row) => (
              <CommentThread key={row.opportunity.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </>
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
        <span className="text-xs text-ink-500">{row.opportunity.contextLabel}</span>
        <span className="text-xs text-ink-500 ml-auto truncate max-w-xs">
          {row.opportunity.threadTitle}
        </span>
      </header>
      <ul className="row-divider">
        {row.comments.map((c) => (
          <DraftRow
            key={c.id}
            body={c.body}
            risk={c.risk.level}
            recommendation={c.risk.recommendation}
            label="Comment"
          />
        ))}
        {row.replies.map((r) => (
          <DraftRow
            key={r.id}
            body={r.body}
            risk={r.risk.level}
            recommendation={r.risk.recommendation}
            label="Reply"
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
  label,
}: {
  body: string;
  risk: ConversationRiskLevel;
  recommendation: string;
  label: "Comment" | "Reply";
}) {
  return (
    <li className="px-5 py-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="badge-neutral text-[10px]">{label}</span>
        <span className={riskTones[risk]}>{risk}</span>
      </div>
      <p className="text-sm text-ink-800 whitespace-pre-line leading-relaxed">{body}</p>
      <p className="text-xs text-ink-500 mt-2 italic">{recommendation}</p>
    </li>
  );
}
