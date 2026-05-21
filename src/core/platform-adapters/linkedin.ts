import type {
  ContentOpportunity,
  ContentOpportunityKind,
  DraftVariant,
  ProductProfile,
  SourceInsight,
} from "@/types";
import { scanText } from "../content-intelligence/guardrails";

interface AdaptInput {
  insight: SourceInsight;
  opportunity: ContentOpportunity;
  product: ProductProfile;
  knownHooks: string[];
}

const supported: ContentOpportunityKind[] = [
  "authority_post",
  "professional_insight",
  "case_study",
  "thoughtful_comment",
  "founder_lesson",
];

export function isLinkedInKind(kind: ContentOpportunityKind): boolean {
  return supported.includes(kind);
}

export function adaptToLinkedIn(input: AdaptInput): DraftVariant[] {
  const { insight, opportunity, product, knownHooks } = input;
  if (!isLinkedInKind(opportunity.kind)) return [];

  const variants: DraftVariant[] = [];

  if (
    opportunity.kind === "authority_post" ||
    opportunity.kind === "professional_insight" ||
    opportunity.kind === "founder_lesson"
  ) {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: authorityHook(insight),
        body: authorityBody(insight),
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
        ctaIntensity: "contextual",
        hook: authorityHook(insight),
        body: authorityBody(insight) + closingWithLink(product),
        cta: product.allowedCtaCopy[0] ?? null,
        hasLink: true,
      }),
    );
  }

  if (opportunity.kind === "case_study") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "moderate",
        ctaIntensity: "contextual",
        hook: `Case: ${insight.title}`,
        body: caseStudyBody(insight),
        cta: product.allowedCtaCopy[0] ?? null,
        hasLink: true,
      }),
    );
  }

  if (opportunity.kind === "thoughtful_comment") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: "Thoughtful comment (template)",
        body: commentBody(insight),
        cta: null,
        hasLink: false,
      }),
    );
  }

  return variants;
}

function authorityHook(insight: SourceInsight): string {
  return insight.title;
}

function authorityBody(insight: SourceInsight): string {
  return [
    `${insight.coreInsight}`,
    "",
    `Three observations from working on this in practice:`,
    `1. ${insight.summary}`,
    `2. ${actionPhrase(insight)}`,
    `3. The temptation is to over-systematize; the actual answer is usually quieter.`,
    "",
    `Not a hot take — just what's worked.`,
  ].join("\n");
}

function caseStudyBody(insight: SourceInsight): string {
  return [
    `${insight.title}`,
    "",
    `${insight.coreInsight}`,
    "",
    `What we measured: ${insight.summary}.`,
    `What we changed: ${actionPhrase(insight)}.`,
    `What the result actually was: we'll cover that in detail in the linked piece.`,
  ].join("\n");
}

function commentBody(insight: SourceInsight): string {
  return [
    `Agree, with one nuance: ${insight.coreInsight}`,
    "",
    `In our own work, that played out as: ${actionPhrase(insight)}.`,
  ].join("\n");
}

function closingWithLink(product: ProductProfile): string {
  return `\n\nFull write-up linked below — written for ${product.targetAudience[0] ?? "operators"}.`;
}

function actionPhrase(insight: SourceInsight): string {
  const verbs = [
    "separate that workflow from the rest",
    "name the failure mode early",
    "model the cost of getting it wrong",
    "track the side-effect, not just the action",
  ];
  const idx = insight.id.length % verbs.length;
  return verbs[idx];
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
    platform: "linkedin",
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
