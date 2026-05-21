import type {
  ContentOpportunity,
  ContentOpportunityKind,
  OpportunityImpact,
  PlatformFitLevel,
  ProductProfile,
  SourceInsight,
} from "@/types";

interface OpportunityInput {
  insight: SourceInsight;
  product: ProductProfile;
}

const platformKinds: Record<
  "reddit" | "x" | "linkedin",
  ContentOpportunityKind[]
> = {
  reddit: [
    "discussion_post",
    "question_post",
    "founder_lesson",
    "soft_feedback_request",
    "helpful_comment",
  ],
  x: [
    "short_post",
    "thread",
    "founder_observation",
    "build_in_public_update",
    "reply",
  ],
  linkedin: [
    "authority_post",
    "professional_insight",
    "case_study",
    "thoughtful_comment",
    "founder_lesson",
  ],
};

const fitWeight: Record<PlatformFitLevel, number> = {
  strong: 3,
  medium: 2,
  weak: 1,
  none: 0,
};

export function buildOpportunitiesForInsight(
  input: OpportunityInput,
): ContentOpportunity[] {
  const { insight, product } = input;
  const out: ContentOpportunity[] = [];

  for (const platform of ["reddit", "x", "linkedin"] as const) {
    const fit = insight.platformFit[platform];
    if (fit === "none") continue;
    const kinds = pickKindsForFit(platform, insight, fit);
    for (const kind of kinds) {
      out.push({
        id: `op_${insight.id}_${platform}_${kind}`,
        insightId: insight.id,
        productId: product.id,
        channel: platform,
        kind,
        title: humanizeOpportunityTitle(platform, kind, insight),
        rationale: rationaleFor(platform, kind, insight, fit),
        impact: impactFor(insight, fit),
        status: "candidate",
      });
    }
  }

  if (insight.platformFit.google !== "none" && insight.discoverabilityPotential >= 40) {
    out.push({
      id: `op_${insight.id}_google_signal`,
      insightId: insight.id,
      productId: product.id,
      channel: "google",
      kind: "discoverability_signal",
      title: `Discoverability signal: ${insight.title}`,
      rationale: `Discoverability potential ${insight.discoverabilityPotential}, evergreen score ${insight.evergreenScore}.`,
      impact: insight.discoverabilityPotential >= 70 ? "high" : "medium",
      status: "candidate",
    });
  }

  return out;
}

function pickKindsForFit(
  platform: "reddit" | "x" | "linkedin",
  insight: SourceInsight,
  fit: PlatformFitLevel,
): ContentOpportunityKind[] {
  const allKinds = platformKinds[platform];
  const baseCount = fitWeight[fit];
  if (baseCount === 0) return [];

  const ranked = rankKindsForInsight(platform, insight, allKinds);
  return ranked.slice(0, Math.min(baseCount, ranked.length));
}

function rankKindsForInsight(
  platform: "reddit" | "x" | "linkedin",
  insight: SourceInsight,
  kinds: ContentOpportunityKind[],
): ContentOpportunityKind[] {
  const scored = kinds.map((kind) => ({
    kind,
    score: scoreKind(platform, kind, insight),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.kind);
}

function scoreKind(
  platform: "reddit" | "x" | "linkedin",
  kind: ContentOpportunityKind,
  insight: SourceInsight,
): number {
  let score = 0;

  if (kind === "helpful_comment" || kind === "reply" || kind === "thoughtful_comment") {
    score += insight.conversationScore * 0.9;
  }
  if (kind === "discussion_post" || kind === "question_post") {
    score += insight.conversationScore * 0.8;
  }
  if (kind === "case_study" || kind === "build_in_public_update") {
    score += insight.evergreenScore * 0.7;
  }
  if (kind === "thread" || kind === "authority_post" || kind === "professional_insight") {
    score += insight.discoverabilityPotential * 0.7;
  }
  if (kind === "short_post" || kind === "founder_observation") {
    score += insight.freshnessPotential * 0.6;
  }
  if (kind === "founder_lesson" || kind === "soft_feedback_request") {
    score += insight.conversationScore * 0.6 + insight.evergreenScore * 0.3;
  }

  if (platform === "reddit" && insight.riskLevel === "high") {
    score -= 30;
  }
  if (platform === "linkedin" && insight.category === "industry_pattern") {
    score += 10;
  }
  if (platform === "x" && insight.category === "founder_observation") {
    score += 10;
  }

  return score;
}

function rationaleFor(
  platform: "reddit" | "x" | "linkedin",
  kind: ContentOpportunityKind,
  insight: SourceInsight,
  fit: PlatformFitLevel,
): string {
  const fitWord = fit === "strong" ? "strong" : fit === "medium" ? "decent" : "limited";
  if (kind === "helpful_comment" || kind === "thoughtful_comment" || kind === "reply") {
    return `${fitWord} fit; conversation score ${insight.conversationScore} suggests this fits comment-first participation.`;
  }
  if (kind === "discussion_post" || kind === "question_post") {
    return `${fitWord} fit; insight invites discussion (score ${insight.conversationScore}).`;
  }
  if (kind === "case_study") {
    return `${fitWord} fit; evergreen score ${insight.evergreenScore} supports a case study framing.`;
  }
  if (kind === "thread") {
    return `${fitWord} fit; discoverability potential ${insight.discoverabilityPotential} supports thread depth.`;
  }
  if (kind === "build_in_public_update") {
    return `${fitWord} fit; freshness potential ${insight.freshnessPotential} supports a working note.`;
  }
  return `${fitWord} fit; insight matches ${platform} content shape.`;
}

function impactFor(insight: SourceInsight, fit: PlatformFitLevel): OpportunityImpact {
  if (fit === "strong" && insight.conversationScore >= 70) return "high";
  if (fit === "strong" || insight.evergreenScore >= 70) return "medium";
  return "low";
}

function humanizeOpportunityTitle(
  platform: "reddit" | "x" | "linkedin",
  kind: ContentOpportunityKind,
  insight: SourceInsight,
): string {
  const platformLabel = platform === "x" ? "X" : platform === "reddit" ? "Reddit" : "LinkedIn";
  const kindLabel = kind.replace(/_/g, " ");
  return `${platformLabel} ${kindLabel}: ${insight.title}`;
}
