import type { PlatformId } from "./platform";

export type InsightCategory =
  | "founder_observation"
  | "product_lesson"
  | "support_pattern"
  | "workflow_problem"
  | "user_problem"
  | "seo_opportunity"
  | "discoverability_gap"
  | "industry_pattern"
  | "operational_lesson"
  | "evergreen_topic";

export type InsightAudience =
  | "founders"
  | "operators"
  | "developers"
  | "freelancers"
  | "small_business"
  | "support_teams"
  | "marketers"
  | "general";

export type PlatformFitLevel = "strong" | "medium" | "weak" | "none";

export interface PlatformFit {
  reddit: PlatformFitLevel;
  x: PlatformFitLevel;
  linkedin: PlatformFitLevel;
  google: PlatformFitLevel;
}

export interface SourceInsight {
  id: string;
  productId: string;
  title: string;
  coreInsight: string;
  summary: string;
  category: InsightCategory;
  sourceType: InsightCategory;
  audience: InsightAudience[];
  discoverabilityPotential: number;
  evergreenScore: number;
  conversationScore: number;
  freshnessPotential: number;
  riskLevel: "low" | "medium" | "high";
  platformFit: PlatformFit;
  createdAt: string;
}

export type ContentOpportunityKind =
  | "discussion_post"
  | "question_post"
  | "founder_lesson"
  | "soft_feedback_request"
  | "helpful_comment"
  | "short_post"
  | "thread"
  | "reply"
  | "build_in_public_update"
  | "founder_observation"
  | "authority_post"
  | "professional_insight"
  | "case_study"
  | "thoughtful_comment"
  | "discoverability_signal";

export type OpportunityImpact = "low" | "medium" | "high";
export type OpportunityStatus =
  | "candidate"
  | "drafted"
  | "queued"
  | "approved"
  | "skipped";

export type OpportunityChannel = PlatformId | "google";

export interface ContentOpportunity {
  id: string;
  insightId: string;
  productId: string;
  channel: OpportunityChannel;
  kind: ContentOpportunityKind;
  title: string;
  rationale: string;
  impact: OpportunityImpact;
  status: OpportunityStatus;
}

export type ToneStrength = "calm" | "moderate" | "direct";
export type CtaIntensity = "none" | "soft" | "contextual";

export interface DraftVariant {
  id: string;
  opportunityId: string;
  insightId: string;
  platform: PlatformId;
  kind: ContentOpportunityKind;
  toneStrength: ToneStrength;
  ctaIntensity: CtaIntensity;
  hook: string;
  body: string;
  cta: string | null;
  hasLink: boolean;
  guardrailFlags: GuardrailFlag[];
}

export type GuardrailFlag =
  | "cta_too_aggressive"
  | "repeated_wording"
  | "duplicate_hook"
  | "low_context"
  | "launch_language"
  | "fake_certainty"
  | "unsupported_claim"
  | "startup_cliche"
  | "ai_voice"
  | "generic_phrasing";

export interface GuardrailReport {
  flags: GuardrailFlag[];
  notes: string[];
  passes: boolean;
}

export interface ContentMemoryRecord {
  insightId: string;
  weekStartIso: string;
  channels: OpportunityChannel[];
}

export interface ContentMemorySummary {
  totalInsights: number;
  usedThisWeek: number;
  usedPriorWeek: number;
  evergreenAvailable: number;
  stale: number;
  underused: number;
  repeatedHooks: { hook: string; count: number }[];
}
