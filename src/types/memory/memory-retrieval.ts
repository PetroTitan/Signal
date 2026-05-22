import type { AiUseCase } from "@/core/ai";
import type { SupportedChannel } from "@/core/platform-connections/platform-capabilities";
import type { WorkspaceMemory } from "./workspace-memory";
import type { PlatformMemory } from "./platform-memory";
import type { ProductMemory } from "./product-memory";
import type { AccountMemory } from "./account-memory";
import type { HistoricalPattern } from "./historical-pattern";
import type { RiskMemory } from "./risk-memory";
import type { AiPreference } from "./ai-preference";
import type { BlockedPhrase } from "./blocked-phrase";

export const MEMORY_RETRIEVAL_SCHEMA_VERSION = 1;

export const MEMORY_ENTITY_KINDS = [
  "workspace",
  "platform",
  "product",
  "account",
  "historical_pattern",
  "risk",
  "ai_preference",
  "blocked_phrase",
] as const;

export type MemoryEntityKind = (typeof MEMORY_ENTITY_KINDS)[number];

export interface MemoryRetrievalQuery {
  taskType: AiUseCase;
  workspaceId: string;
  productId?: string;
  accountId?: string;
  platform?: SupportedChannel;
  kinds?: MemoryEntityKind[];
  maxItems?: number;
  tokenBudget: number;
}

export type MemoryPayloadMap = {
  workspace: WorkspaceMemory;
  platform: PlatformMemory;
  product: ProductMemory;
  account: AccountMemory;
  historical_pattern: HistoricalPattern;
  risk: RiskMemory;
  ai_preference: AiPreference;
  blocked_phrase: BlockedPhrase;
};

export type RetrievedMemory = {
  [K in MemoryEntityKind]: {
    kind: K;
    id: string;
    relevance: number;
    estimatedTokens: number;
    payload: MemoryPayloadMap[K];
  };
}[MemoryEntityKind];

export interface MemoryRetrievalSourceCount {
  kind: MemoryEntityKind;
  count: number;
}

export interface MemoryRetrievalResult {
  query: MemoryRetrievalQuery;
  items: RetrievedMemory[];
  totalEstimatedTokens: number;
  truncated: boolean;
  sources: MemoryRetrievalSourceCount[];
}
