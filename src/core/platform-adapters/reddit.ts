import type {
  ContentOpportunity,
  ContentOpportunityKind,
  DraftVariant,
  SourceInsight,
} from "@/types";
import { scanText } from "../content-intelligence/guardrails";

interface AdaptInput {
  insight: SourceInsight;
  opportunity: ContentOpportunity;
  knownHooks: string[];
}

const supported: ContentOpportunityKind[] = [
  "discussion_post",
  "question_post",
  "founder_lesson",
  "soft_feedback_request",
  "helpful_comment",
];

export function isRedditKind(kind: ContentOpportunityKind): boolean {
  return supported.includes(kind);
}

export function adaptToReddit(input: AdaptInput): DraftVariant[] {
  const { insight, opportunity, knownHooks } = input;
  if (!isRedditKind(opportunity.kind)) return [];

  const variants: DraftVariant[] = [];

  if (opportunity.kind === "discussion_post" || opportunity.kind === "question_post") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: questionHook(insight),
        body: discussionBody(insight),
        cta: null,
        hasLink: false,
      }),
    );
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "moderate",
        ctaIntensity: "soft",
        hook: observationHook(insight),
        body: discussionBody(insight) +
          "\n\nWe ended up writing about this — happy to share the post in the comments if it'd be useful.",
        cta: null,
        hasLink: false,
      }),
    );
  }

  if (opportunity.kind === "founder_lesson") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: `A lesson from working on ${insight.title.toLowerCase()}`,
        body: lessonBody(insight),
        cta: null,
        hasLink: false,
      }),
    );
  }

  if (opportunity.kind === "soft_feedback_request") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "soft",
        hook: `Curious how you handle: ${insight.title.toLowerCase()}`,
        body: feedbackBody(insight),
        cta: null,
        hasLink: false,
      }),
    );
  }

  if (opportunity.kind === "helpful_comment") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: "Helpful reply (template)",
        body: commentBody(insight),
        cta: null,
        hasLink: false,
      }),
    );
  }

  return variants;
}

function questionHook(insight: SourceInsight): string {
  return `How are you handling ${insight.title.toLowerCase()}?`;
}

function observationHook(insight: SourceInsight): string {
  return `Pattern we keep seeing: ${insight.title.toLowerCase()}`;
}

function discussionBody(insight: SourceInsight): string {
  return [
    `${insight.coreInsight}`,
    "",
    "Curious how others in this subreddit are handling it — what tooling, what trade-offs, what you tried that didn't work.",
  ].join("\n");
}

function lessonBody(insight: SourceInsight): string {
  return [
    `${insight.coreInsight}`,
    "",
    `Sharing this as a small lesson, not a sales pitch. ${insight.summary}`,
  ].join("\n");
}

function feedbackBody(insight: SourceInsight): string {
  return [
    `${insight.coreInsight}`,
    "",
    `Our approach has been to ${actionFromInsight(insight)}. Open to a different angle.`,
  ].join("\n");
}

function commentBody(insight: SourceInsight): string {
  return [
    `One thing we learned: ${insight.coreInsight}`,
    "",
    "Hope that's useful for the thread.",
  ].join("\n");
}

function actionFromInsight(insight: SourceInsight): string {
  const verbs = ["frame", "track", "model", "design", "talk about", "measure"];
  const idx = insight.id.length % verbs.length;
  return `${verbs[idx]} this as a separate workflow rather than a one-off`;
}

function build(args: {
  opportunity: ContentOpportunity;
  insight: SourceInsight;
  knownHooks: string[];
  toneStrength: DraftVariant["toneStrength"];
  ctaIntensity: DraftVariant["ctaIntensity"];
  hook: string;
  body: string;
  cta: string | null;
  hasLink: boolean;
}): DraftVariant {
  const report = scanText({
    hook: args.hook,
    body: args.body,
    cta: args.cta,
    knownHooks: args.knownHooks,
  });
  return {
    id: `dv_${args.opportunity.id}_${args.toneStrength}_${args.ctaIntensity}`,
    opportunityId: args.opportunity.id,
    insightId: args.insight.id,
    platform: "reddit",
    kind: args.opportunity.kind,
    toneStrength: args.toneStrength,
    ctaIntensity: args.ctaIntensity,
    hook: args.hook,
    body: args.body,
    cta: args.cta,
    hasLink: args.hasLink,
    guardrailFlags: report.flags,
  };
}
