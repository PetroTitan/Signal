import type {
  CommentDraft,
  DiscussionOpportunity,
  ReplyDraft,
  SourceInsight,
} from "@/types";
import { scoreConversationRisk } from "./risk";

interface CommentInput {
  opportunity: DiscussionOpportunity;
  insights: SourceInsight[];
  knownBodies: string[];
}

export function buildCommentDrafts({
  opportunity,
  insights,
  knownBodies,
}: CommentInput): CommentDraft[] {
  if (opportunity.recommendation === "skip") return [];
  if (opportunity.platform === "reddit") {
    return redditComments({ opportunity, insights, knownBodies });
  }
  if (opportunity.platform === "linkedin") {
    return linkedinComments({ opportunity, insights, knownBodies });
  }
  return [];
}

export function buildReplyDrafts({
  opportunity,
  insights,
  knownBodies,
}: CommentInput): ReplyDraft[] {
  if (opportunity.recommendation === "skip") return [];
  if (opportunity.platform !== "x") return [];
  return xReplies({ opportunity, insights, knownBodies });
}

function redditComments(input: CommentInput): CommentDraft[] {
  const drafts: CommentDraft[] = [];
  const matched = input.insights.filter((i) =>
    input.opportunity.matchedInsightIds.includes(i.id),
  );
  if (matched.length === 0) return drafts;
  for (const insight of matched.slice(0, 2)) {
    const body = redditBody(insight, input.opportunity);
    drafts.push(
      buildCommentDraft({
        opportunity: input.opportunity,
        body,
        toneStrength: "calm",
        knownBodies: input.knownBodies,
      }),
    );
  }
  return drafts;
}

function linkedinComments(input: CommentInput): CommentDraft[] {
  const drafts: CommentDraft[] = [];
  const matched = input.insights.filter((i) =>
    input.opportunity.matchedInsightIds.includes(i.id),
  );
  if (matched.length === 0) return drafts;
  for (const insight of matched.slice(0, 2)) {
    drafts.push(
      buildCommentDraft({
        opportunity: input.opportunity,
        body: linkedinBody(insight, input.opportunity),
        toneStrength: "moderate",
        knownBodies: input.knownBodies,
      }),
    );
  }
  return drafts;
}

function xReplies(input: CommentInput): ReplyDraft[] {
  const drafts: ReplyDraft[] = [];
  const matched = input.insights.filter((i) =>
    input.opportunity.matchedInsightIds.includes(i.id),
  );
  if (matched.length === 0) return drafts;
  for (const insight of matched.slice(0, 2)) {
    const body = xReplyBody(insight, input.opportunity);
    const { risk, flags } = scoreConversationRisk({
      body,
      hasLink: false,
      knownBodies: input.knownBodies,
      opportunity: input.opportunity,
    });
    drafts.push({
      id: `reply_${input.opportunity.id}_${insight.id}`,
      opportunityId: input.opportunity.id,
      platform: "x",
      body,
      toneStrength: "calm",
      guardrailFlags: flags,
      risk,
    });
  }
  return drafts;
}

function buildCommentDraft(args: {
  opportunity: DiscussionOpportunity;
  body: string;
  toneStrength: "calm" | "moderate";
  knownBodies: string[];
}): CommentDraft {
  const { risk, flags } = scoreConversationRisk({
    body: args.body,
    hasLink: false,
    knownBodies: args.knownBodies,
    opportunity: args.opportunity,
  });
  return {
    id: `cmt_${args.opportunity.id}_${args.toneStrength}_${args.body.length}`,
    opportunityId: args.opportunity.id,
    platform: args.opportunity.platform,
    body: args.body,
    toneStrength: args.toneStrength,
    hasLink: false,
    guardrailFlags: flags,
    risk,
  };
}

function redditBody(
  insight: SourceInsight,
  opportunity: DiscussionOpportunity,
): string {
  return [
    `One pattern we've seen on this: ${shortenInsight(insight)}.`,
    "",
    `In our experience, the angle that actually held was ${actionPhrase(insight)}.`,
    "",
    matchedAck(opportunity),
  ]
    .filter(Boolean)
    .join("\n");
}

function linkedinBody(
  insight: SourceInsight,
  opportunity: DiscussionOpportunity,
): string {
  return [
    `Adding one nuance to ${opportunity.threadTitle}:`,
    "",
    shortenInsight(insight),
    "",
    `For us it played out as ${actionPhrase(insight)} — happy to share specifics if useful.`,
  ].join("\n");
}

function xReplyBody(
  insight: SourceInsight,
  opportunity: DiscussionOpportunity,
): string {
  return `One thing we've seen: ${shortenInsight(insight)}. ${matchedTail(opportunity)}`;
}

function shortenInsight(insight: SourceInsight): string {
  return insight.coreInsight.replace(/\s+/g, " ").trim();
}

function actionPhrase(insight: SourceInsight): string {
  const phrases = [
    "separating the workflow from the rest",
    "naming the failure mode early",
    "measuring the side-effect, not the action",
    "tracking the missing variable as its own number",
    "treating it as a habit instead of a project",
  ];
  return phrases[insight.id.length % phrases.length];
}

function matchedAck(opportunity: DiscussionOpportunity): string {
  if (opportunity.communityFit.level === "strong") {
    return "Curious how this maps to others here.";
  }
  if (opportunity.communityFit.level === "medium") {
    return "Not sure if this is the angle the thread wants — happy to elaborate if so.";
  }
  return "";
}

function matchedTail(opportunity: DiscussionOpportunity): string {
  if (opportunity.participation.freshness === "active") {
    return "Curious how you've handled it.";
  }
  return "Late, but wanted to share that.";
}
