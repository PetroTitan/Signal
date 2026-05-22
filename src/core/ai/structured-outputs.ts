import type { PlatformId, RiskLevel } from "@/types";
import type { AiUseCase } from "./ai-use-cases";

export interface RewriteOutput {
  text: string;
  changes_made: string[];
  risk_reduction_notes: string[];
  remaining_warnings: string[];
}

export interface DraftVariantOutput {
  title: string;
  body: string;
  platform: PlatformId;
  content_type: string;
  tone: "calm" | "moderate" | "direct";
  cta_level: "none" | "soft" | "contextual";
  link_recommendation: "no_link" | "soft_link" | "contextual_link";
  risk_notes: string[];
}

export interface CommentPolishOutput {
  comment_text: string;
  relevance_reason: string;
  promotional_risk: RiskLevel;
  should_post: boolean;
  skip_reason?: string;
}

export interface InsightExtractionOutput {
  title: string;
  core_insight: string;
  summary: string;
  category: string;
  candidate_audiences: string[];
}

export interface PlatformAdaptationOutput {
  platform: PlatformId;
  variants: DraftVariantOutput[];
}

export interface SummarizeOpportunityOutput {
  one_line: string;
  rationale: string;
  suggested_action: string;
}

export interface RiskExplanationOutput {
  summary: string;
  reasons: string[];
  recommendation: string;
  blocked_actions: string[];
}

export interface ConvertToCommentOutput {
  comment_text: string;
  removed_cta: boolean;
  removed_link: boolean;
  rationale: string;
}

export interface RemovePromotionalToneOutput {
  text: string;
  removed_phrases: string[];
  kept_intent: string;
}

export interface GenerateTitleOptionsOutput {
  options: string[];
}

export type AiOutput =
  | { useCase: "rewrite_softer"; payload: RewriteOutput }
  | { useCase: "draft_variant"; payload: DraftVariantOutput }
  | { useCase: "comment_polish"; payload: CommentPolishOutput }
  | { useCase: "insight_extraction"; payload: InsightExtractionOutput }
  | { useCase: "platform_adaptation"; payload: PlatformAdaptationOutput }
  | { useCase: "summarize_opportunity"; payload: SummarizeOpportunityOutput }
  | { useCase: "explain_risk"; payload: RiskExplanationOutput }
  | { useCase: "convert_post_to_comment"; payload: ConvertToCommentOutput }
  | { useCase: "remove_promotional_tone"; payload: RemovePromotionalToneOutput }
  | { useCase: "generate_title_options"; payload: GenerateTitleOptionsOutput };

export type AiOutputPayloadFor<U extends AiUseCase> = Extract<
  AiOutput,
  { useCase: U }
>["payload"];
