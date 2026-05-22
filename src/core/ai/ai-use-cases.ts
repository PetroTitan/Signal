export const ALLOWED_AI_USE_CASES = [
  "rewrite_softer",
  "draft_variant",
  "comment_polish",
  "insight_extraction",
  "platform_adaptation",
  "summarize_opportunity",
  "explain_risk",
  "convert_post_to_comment",
  "remove_promotional_tone",
  "generate_title_options",
] as const;

export type AiUseCase = (typeof ALLOWED_AI_USE_CASES)[number];

export const BLOCKED_AI_USE_CASES = [
  "autonomous_posting",
  "autonomous_commenting",
  "mass_generation",
  "fake_engagement",
  "engagement_bait_generation",
  "policy_evasion",
  "account_warming_automation",
  "platform_bypass",
  "spam_variation_generation",
  "fake_testimonial_generation",
  "fake_metric_generation",
] as const;

export type BlockedAiUseCase = (typeof BLOCKED_AI_USE_CASES)[number];

export function isAllowedUseCase(value: string): value is AiUseCase {
  return (ALLOWED_AI_USE_CASES as readonly string[]).includes(value);
}

export function isBlockedUseCase(value: string): value is BlockedAiUseCase {
  return (BLOCKED_AI_USE_CASES as readonly string[]).includes(value);
}

export const USE_CASE_LABELS: Record<AiUseCase, string> = {
  rewrite_softer: "Rewrite softer",
  draft_variant: "Generate draft variant",
  comment_polish: "Polish a comment",
  insight_extraction: "Extract a source insight",
  platform_adaptation: "Adapt to a platform",
  summarize_opportunity: "Summarize an opportunity",
  explain_risk: "Explain a risk score",
  convert_post_to_comment: "Convert a post into a comment",
  remove_promotional_tone: "Remove promotional tone",
  generate_title_options: "Generate title options",
};
