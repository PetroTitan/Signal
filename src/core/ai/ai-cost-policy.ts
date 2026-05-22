export const AI_COST_POLICY = {
  noCallsOnRender: true,
  noBackgroundLoops: true,
  humanTriggeredOnly: true,
  batchFriendly: true,
  outputsCacheable: true,
  maxVariantsPerRequest: 3,
  weeklyGenerationBudgetTokensSoft: 50_000,
  perWorkspaceWeeklyCallsSoft: 200,
  preferCheapModelsFor: [
    "rewrite_softer",
    "remove_promotional_tone",
    "convert_post_to_comment",
    "summarize_opportunity",
    "explain_risk",
    "generate_title_options",
  ],
  preferExpensiveModelsFor: [
    "draft_variant",
    "platform_adaptation",
    "insight_extraction",
    "comment_polish",
  ],
} as const;

export const AI_COST_POLICY_NOTES = [
  "AI never runs on render. Every call is human-triggered.",
  "No autonomous background loops. No silent retries.",
  "Outputs are cacheable per (use case, input hash).",
  "Cheap models handle structural transforms; expensive models reserved for final polish.",
  "Per-workspace soft limits apply once billing is wired.",
];
