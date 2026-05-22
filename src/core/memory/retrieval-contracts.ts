import type {
  MemoryRetrievalQuery,
  MemoryRetrievalResult,
} from "@/types/memory";

export interface MemoryRetriever {
  retrieve(query: MemoryRetrievalQuery): Promise<MemoryRetrievalResult>;
}

export const RETRIEVAL_CONTRACT_RULES = [
  "Never return all memory. Always rank and cap by token budget.",
  "Same-platform and same-product items rank above generic items.",
  "Risk and blocked_phrase items are eligible even at low base relevance.",
  "Workspace memory is always included if it fits in the budget.",
  "Results are deterministic for the same query and memory snapshot.",
  "Retrieval performs no model calls.",
] as const;

export const MAX_ITEMS_DEFAULT = 12;
