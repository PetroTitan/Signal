import type {
  MemoryEntityKind,
  MemoryRetrievalQuery,
  RetrievedMemory,
} from "@/types/memory";
import type { AiUseCase } from "@/core/ai";

export interface ScorableMemoryItem {
  kind: MemoryEntityKind;
  id: string;
  platform?: string;
  productId?: string | null;
  accountId?: string | null;
  taskTypes?: AiUseCase[];
  confidence?: number;
  lastSeenAt?: string;
  estimatedTokens: number;
  payload: RetrievedMemory["payload"];
}

const KIND_BASE_RELEVANCE: Record<MemoryEntityKind, number> = {
  workspace: 0.55,
  platform: 0.45,
  product: 0.45,
  account: 0.45,
  risk: 0.4,
  historical_pattern: 0.3,
  ai_preference: 0.35,
  blocked_phrase: 0.5,
};

const PLATFORM_MATCH_BONUS = 0.3;
const PRODUCT_MATCH_BONUS = 0.3;
const ACCOUNT_MATCH_BONUS = 0.2;
const TASK_TYPE_MATCH_BONUS = 0.2;
const CONFIDENCE_BONUS_MAX = 0.1;
const RECENCY_BONUS_MAX = 0.1;
const RECENCY_HALF_LIFE_DAYS = 30;

function recencyBonus(lastSeenAt: string | undefined): number {
  if (!lastSeenAt) return 0;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return 0;
  const days = Math.max(0, (Date.now() - seen) / (1000 * 60 * 60 * 24));
  const decay = Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
  return RECENCY_BONUS_MAX * decay;
}

export function scoreMemoryItem(
  item: ScorableMemoryItem,
  query: MemoryRetrievalQuery,
): number {
  let score = KIND_BASE_RELEVANCE[item.kind];

  if (item.platform && query.platform && item.platform === query.platform) {
    score += PLATFORM_MATCH_BONUS;
  }
  if (item.productId && query.productId && item.productId === query.productId) {
    score += PRODUCT_MATCH_BONUS;
  }
  if (item.accountId && query.accountId && item.accountId === query.accountId) {
    score += ACCOUNT_MATCH_BONUS;
  }
  if (item.taskTypes && item.taskTypes.includes(query.taskType)) {
    score += TASK_TYPE_MATCH_BONUS;
  }
  if (typeof item.confidence === "number") {
    score += CONFIDENCE_BONUS_MAX * Math.max(0, Math.min(1, item.confidence));
  }
  score += recencyBonus(item.lastSeenAt);

  return Math.max(0, Math.min(1, score));
}

export interface RankedMemoryItem extends ScorableMemoryItem {
  relevance: number;
}

export function rankMemoryItems(
  items: ScorableMemoryItem[],
  query: MemoryRetrievalQuery,
): RankedMemoryItem[] {
  return items
    .map((it) => ({ ...it, relevance: scoreMemoryItem(it, query) }))
    .sort((a, b) => b.relevance - a.relevance);
}
