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
  "short_post",
  "thread",
  "founder_observation",
  "build_in_public_update",
  "reply",
];

export function isXKind(kind: ContentOpportunityKind): boolean {
  return supported.includes(kind);
}

export function adaptToX(input: AdaptInput): DraftVariant[] {
  const { insight, opportunity, product, knownHooks } = input;
  if (!isXKind(opportunity.kind)) return [];

  const variants: DraftVariant[] = [];

  if (opportunity.kind === "short_post" || opportunity.kind === "founder_observation") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: shortenHook(insight, "calm"),
        body: shortBody(insight, false),
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
        hook: shortenHook(insight, "moderate"),
        body: shortBody(insight, true),
        cta: softCta(product),
        hasLink: true,
      }),
    );
  }

  if (opportunity.kind === "thread") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: `Thread: ${shortenHook(insight, "calm")}`,
        body: threadBody(insight, false),
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
        hook: `Thread: ${shortenHook(insight, "moderate")}`,
        body: threadBody(insight, true),
        cta: softCta(product),
        hasLink: true,
      }),
    );
  }

  if (opportunity.kind === "build_in_public_update") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: `Working note: ${shortenHook(insight, "calm")}`,
        body: bipBody(insight),
        cta: null,
        hasLink: false,
      }),
    );
  }

  if (opportunity.kind === "reply") {
    variants.push(
      build({
        opportunity,
        insight,
        knownHooks,
        toneStrength: "calm",
        ctaIntensity: "none",
        hook: "Reply (template)",
        body: replyBody(insight),
        cta: null,
        hasLink: false,
      }),
    );
  }

  return variants;
}

function shortenHook(insight: SourceInsight, tone: "calm" | "moderate"): string {
  const base = insight.title.replace(/\.+$/, "");
  if (tone === "calm") {
    return base;
  }
  if (base.length > 80) return base.slice(0, 77).trimEnd() + "…";
  return base;
}

function shortBody(insight: SourceInsight, withSoftLink: boolean): string {
  const sentence = oneSentence(insight.coreInsight);
  if (!withSoftLink) return sentence;
  return `${sentence}\n\nWe wrote a small note on this — link in a reply if useful.`;
}

function threadBody(insight: SourceInsight, withSoftLink: boolean): string {
  const lines = [
    `1/ ${oneSentence(insight.coreInsight)}`,
    `2/ The pattern: ${insight.summary}`,
    `3/ What we tried first didn't hold. What did:`,
    `4/ ${actionFromInsight(insight)}`,
    `5/ If you've seen this differently, curious how you've handled it.`,
  ];
  if (withSoftLink) {
    lines.push(`6/ Longer write-up linked in a reply for anyone who wants it.`);
  }
  return lines.join("\n");
}

function bipBody(insight: SourceInsight): string {
  return [
    oneSentence(insight.coreInsight),
    "",
    `What changed this week: ${actionFromInsight(insight)}.`,
  ].join("\n");
}

function replyBody(insight: SourceInsight): string {
  return `One thing we've seen: ${oneSentence(insight.coreInsight)}`;
}

function softCta(product: ProductProfile): string | null {
  if (product.allowedCtaCopy.length === 0) return null;
  return product.allowedCtaCopy[0];
}

function actionFromInsight(insight: SourceInsight): string {
  const verbs = ["isolate", "name it", "separate the workflow", "track it as its own thing", "model it differently"];
  const idx = insight.id.length % verbs.length;
  return verbs[idx];
}

function oneSentence(s: string): string {
  const trimmed = s.trim();
  const period = trimmed.indexOf(".");
  if (period > 20 && period < trimmed.length - 1) {
    return trimmed.slice(0, period + 1);
  }
  return trimmed;
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
    platform: "x",
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
