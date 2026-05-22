import type { AiUseCase } from "@/core/ai";

export type TruncationStrategy =
  | "drop_low_relevance"
  | "compress_long_fields"
  | "limit_layers";

export interface TokenBudget {
  taskType: AiUseCase;
  maxTokens: number;
  warnAtPercent: number;
  truncationStrategy: TruncationStrategy;
}

export const TOKEN_BUDGETS: Record<AiUseCase, TokenBudget> = {
  rewrite_softer: {
    taskType: "rewrite_softer",
    maxTokens: 2000,
    warnAtPercent: 0.8,
    truncationStrategy: "drop_low_relevance",
  },
  comment_polish: {
    taskType: "comment_polish",
    maxTokens: 2000,
    warnAtPercent: 0.8,
    truncationStrategy: "drop_low_relevance",
  },
  remove_promotional_tone: {
    taskType: "remove_promotional_tone",
    maxTokens: 2000,
    warnAtPercent: 0.8,
    truncationStrategy: "drop_low_relevance",
  },
  convert_post_to_comment: {
    taskType: "convert_post_to_comment",
    maxTokens: 2500,
    warnAtPercent: 0.8,
    truncationStrategy: "drop_low_relevance",
  },
  platform_adaptation: {
    taskType: "platform_adaptation",
    maxTokens: 3000,
    warnAtPercent: 0.8,
    truncationStrategy: "compress_long_fields",
  },
  generate_title_options: {
    taskType: "generate_title_options",
    maxTokens: 3000,
    warnAtPercent: 0.8,
    truncationStrategy: "drop_low_relevance",
  },
  summarize_opportunity: {
    taskType: "summarize_opportunity",
    maxTokens: 3000,
    warnAtPercent: 0.8,
    truncationStrategy: "compress_long_fields",
  },
  explain_risk: {
    taskType: "explain_risk",
    maxTokens: 3000,
    warnAtPercent: 0.8,
    truncationStrategy: "compress_long_fields",
  },
  insight_extraction: {
    taskType: "insight_extraction",
    maxTokens: 4000,
    warnAtPercent: 0.85,
    truncationStrategy: "compress_long_fields",
  },
  draft_variant: {
    taskType: "draft_variant",
    maxTokens: 5000,
    warnAtPercent: 0.85,
    truncationStrategy: "limit_layers",
  },
};

export function getBudget(taskType: AiUseCase): TokenBudget {
  return TOKEN_BUDGETS[taskType];
}

const AVG_CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

export function estimateObjectTokens(obj: unknown): number {
  try {
    return estimateTokens(JSON.stringify(obj));
  } catch {
    return 0;
  }
}

export interface BudgetCheck {
  ok: boolean;
  warn: boolean;
  percentUsed: number;
  reason?: string;
}

export function withinBudget(
  budget: TokenBudget,
  estimated: number,
): BudgetCheck {
  const percentUsed = estimated / budget.maxTokens;
  if (estimated > budget.maxTokens) {
    return {
      ok: false,
      warn: true,
      percentUsed,
      reason: "Estimated tokens exceed task budget. Truncation required.",
    };
  }
  if (percentUsed >= budget.warnAtPercent) {
    return {
      ok: true,
      warn: true,
      percentUsed,
      reason: "Estimated tokens approaching budget limit.",
    };
  }
  return { ok: true, warn: false, percentUsed };
}
