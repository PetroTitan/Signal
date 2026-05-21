import type {
  CommunityFitLevel,
  DiscussionOpportunity,
  ParticipationRecommendation,
  PlatformId,
  ProductProfile,
  SourceInsight,
} from "@/types";

interface DiscussionInput {
  opportunity: Omit<
    DiscussionOpportunity,
    | "matchedInsightIds"
    | "communityFit"
    | "participationScore"
    | "recommendation"
    | "skipReason"
  > & {
    productMatches: string[];
  };
  insights: SourceInsight[];
  products: ProductProfile[];
}

export function evaluateDiscussion({
  opportunity,
  insights,
  products,
}: DiscussionInput): DiscussionOpportunity {
  const matchedInsights = matchInsights(opportunity, insights);
  const communityFit = scoreCommunityFit(opportunity, products);
  const participationScore = scoreParticipation({
    fit: communityFit.level,
    matchedCount: matchedInsights.length,
    participation: opportunity.participation,
    platform: opportunity.platform,
  });
  const { recommendation, skipReason } = decide({
    participationScore,
    opportunity,
    matchedCount: matchedInsights.length,
    fit: communityFit.level,
  });

  return {
    ...opportunity,
    matchedInsightIds: matchedInsights.map((i) => i.id),
    communityFit,
    participationScore,
    recommendation,
    skipReason,
  };
}

function matchInsights(
  opportunity: DiscussionInput["opportunity"],
  insights: SourceInsight[],
): SourceInsight[] {
  const productInsights = insights.filter((i) =>
    opportunity.productMatches.includes(i.productId),
  );
  const platformInsights = productInsights.filter(
    (i) => i.platformFit[opportunity.platform] !== "none",
  );
  const tagSet = new Set(opportunity.topicTags.map((t) => t.toLowerCase()));
  const tagMatched = platformInsights.filter((i) =>
    insightTags(i).some((tag) => tagSet.has(tag)),
  );
  return tagMatched.length > 0 ? tagMatched.slice(0, 5) : platformInsights.slice(0, 3);
}

function insightTags(insight: SourceInsight): string[] {
  return [
    ...insight.category.split("_"),
    ...insight.title.toLowerCase().split(/\s+/),
  ].filter((t) => t.length >= 4);
}

function scoreCommunityFit(
  opportunity: DiscussionInput["opportunity"],
  products: ProductProfile[],
): { level: CommunityFitLevel; reason: string } {
  const matchedProducts = products.filter((p) =>
    opportunity.productMatches.includes(p.id),
  );
  if (matchedProducts.length === 0) {
    return {
      level: "off_topic",
      reason: "No product in this workspace aligns with the thread topic.",
    };
  }
  const strong = matchedProducts.some((p) =>
    p.preferredPlatforms.includes(opportunity.platform),
  );
  const audienceMatch = opportunity.participation.audienceMatch;
  if (strong && audienceMatch === "aligned") {
    return {
      level: "strong",
      reason: `${matchedProducts[0].name} treats this platform and audience as primary.`,
    };
  }
  if (audienceMatch === "off") {
    return {
      level: "weak",
      reason: "Audience is off — thread isn't where our buyers live.",
    };
  }
  if (audienceMatch === "adjacent") {
    return {
      level: "medium",
      reason: "Audience is adjacent — useful for trust, not for direct conversion.",
    };
  }
  return {
    level: "medium",
    reason: "Platform fits, audience match unclear.",
  };
}

function scoreParticipation(input: {
  fit: CommunityFitLevel;
  matchedCount: number;
  participation: DiscussionInput["opportunity"]["participation"];
  platform: PlatformId;
}): number {
  let score = 0;
  score += fitScore(input.fit);
  score += Math.min(30, input.matchedCount * 8);
  score += freshnessScore(input.participation.freshness);
  score -= noisePenalty(input.participation.noise);
  if (input.platform === "linkedin" && input.fit === "weak") {
    score -= 10;
  }
  return Math.max(0, Math.min(100, score));
}

function fitScore(level: CommunityFitLevel): number {
  switch (level) {
    case "strong":
      return 40;
    case "medium":
      return 25;
    case "weak":
      return 10;
    case "off_topic":
      return 0;
  }
}

function freshnessScore(
  freshness: DiscussionInput["opportunity"]["participation"]["freshness"],
): number {
  switch (freshness) {
    case "active":
      return 25;
    case "settling":
      return 15;
    case "cold":
      return 5;
  }
}

function noisePenalty(
  noise: DiscussionInput["opportunity"]["participation"]["noise"],
): number {
  switch (noise) {
    case "low":
      return 0;
    case "medium":
      return 10;
    case "high":
      return 25;
  }
}

function decide(input: {
  participationScore: number;
  opportunity: DiscussionInput["opportunity"];
  matchedCount: number;
  fit: CommunityFitLevel;
}): { recommendation: ParticipationRecommendation; skipReason?: string } {
  if (input.fit === "off_topic") {
    return {
      recommendation: "skip",
      skipReason: "Off-topic — no workspace product belongs in this thread.",
    };
  }
  if (input.matchedCount === 0) {
    return {
      recommendation: "skip",
      skipReason: "No matched insight — Signal won't reach for participation.",
    };
  }
  if (input.opportunity.participation.noise === "high" && input.participationScore < 60) {
    return {
      recommendation: "watch",
      skipReason: undefined,
    };
  }
  if (input.opportunity.ageHours > 36 && input.opportunity.participation.freshness === "cold") {
    return {
      recommendation: "skip",
      skipReason: "Thread has cooled and there's no fresh angle to add.",
    };
  }
  if (input.participationScore >= 55) {
    return { recommendation: "participate" };
  }
  if (input.participationScore >= 30) {
    return { recommendation: "watch" };
  }
  return {
    recommendation: "skip",
    skipReason: "Participation score below threshold.",
  };
}
