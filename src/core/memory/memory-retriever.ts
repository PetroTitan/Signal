import type {
  AccountMemory,
  AiPreference,
  BlockedPhrase,
  HistoricalPattern,
  MemoryEntityKind,
  MemoryPayloadMap,
  MemoryRetrievalQuery,
  MemoryRetrievalResult,
  MemoryRetrievalSourceCount,
  PlatformMemory,
  ProductMemory,
  RetrievedMemory,
  RiskMemory,
  WorkspaceMemory,
} from "@/types/memory";
import {
  ACCOUNT_MEMORY_SCHEMA_VERSION,
  AI_PREFERENCE_SCHEMA_VERSION,
  BLOCKED_PHRASE_SCHEMA_VERSION,
  HISTORICAL_PATTERN_SCHEMA_VERSION,
  PLATFORM_MEMORY_SCHEMA_VERSION,
  PRODUCT_MEMORY_SCHEMA_VERSION,
  RISK_MEMORY_SCHEMA_VERSION,
  WORKSPACE_MEMORY_SCHEMA_VERSION,
} from "@/types/memory";
import { estimateObjectTokens } from "./token-budget";
import {
  rankMemoryItems,
  type ScorableMemoryItem,
} from "./relevance-ranking";
import {
  MAX_ITEMS_DEFAULT,
  type MemoryRetriever,
} from "./retrieval-contracts";

export interface MemorySnapshot {
  workspaces: WorkspaceMemory[];
  platforms: PlatformMemory[];
  products: ProductMemory[];
  accounts: AccountMemory[];
  patterns: HistoricalPattern[];
  risks: RiskMemory[];
  aiPreferences: AiPreference[];
  blockedPhrases: BlockedPhrase[];
}

export const EMPTY_MEMORY_SNAPSHOT: MemorySnapshot = {
  workspaces: [],
  platforms: [],
  products: [],
  accounts: [],
  patterns: [],
  risks: [],
  aiPreferences: [],
  blockedPhrases: [],
};

function toScorable(snapshot: MemorySnapshot): ScorableMemoryItem[] {
  const items: ScorableMemoryItem[] = [];

  for (const w of snapshot.workspaces) {
    if (!w.active) continue;
    items.push({
      kind: "workspace",
      id: w.workspaceId,
      estimatedTokens: estimateObjectTokens(w),
      payload: w,
    });
  }
  for (const p of snapshot.platforms) {
    if (!p.active) continue;
    items.push({
      kind: "platform",
      id: p.platform,
      platform: p.platform,
      estimatedTokens: estimateObjectTokens(p),
      payload: p,
    });
  }
  for (const pr of snapshot.products) {
    if (!pr.active) continue;
    items.push({
      kind: "product",
      id: pr.productId,
      productId: pr.productId,
      estimatedTokens: estimateObjectTokens(pr),
      payload: pr,
    });
  }
  for (const a of snapshot.accounts) {
    if (!a.active) continue;
    items.push({
      kind: "account",
      id: a.accountId,
      platform: a.platform,
      accountId: a.accountId,
      estimatedTokens: estimateObjectTokens(a),
      payload: a,
    });
  }
  for (const hp of snapshot.patterns) {
    if (!hp.active) continue;
    items.push({
      kind: "historical_pattern",
      id: hp.id,
      platform: hp.platform === "any" ? undefined : hp.platform,
      productId: hp.productId,
      confidence: hp.confidence,
      lastSeenAt: hp.lastSeenAt,
      estimatedTokens: estimateObjectTokens(hp),
      payload: hp,
    });
  }
  for (const r of snapshot.risks) {
    if (!r.active) continue;
    items.push({
      kind: "risk",
      id: r.id,
      platform: r.platform === "any" ? undefined : r.platform,
      lastSeenAt: r.lastUpdatedAt,
      estimatedTokens: estimateObjectTokens(r),
      payload: r,
    });
  }
  for (const ap of snapshot.aiPreferences) {
    if (!ap.active) continue;
    items.push({
      kind: "ai_preference",
      id: ap.id,
      taskTypes: [ap.useCase],
      lastSeenAt: ap.lastUpdatedAt,
      estimatedTokens: estimateObjectTokens(ap),
      payload: ap,
    });
  }
  for (const bp of snapshot.blockedPhrases) {
    if (!bp.active) continue;
    items.push({
      kind: "blocked_phrase",
      id: bp.id,
      lastSeenAt: bp.lastUpdatedAt,
      estimatedTokens: estimateObjectTokens(bp),
      payload: bp,
    });
  }
  return items;
}

function buildResult(
  query: MemoryRetrievalQuery,
  picked: { kind: MemoryEntityKind; id: string; relevance: number; estimatedTokens: number; payload: unknown }[],
  truncated: boolean,
): MemoryRetrievalResult {
  const counts = new Map<MemoryEntityKind, number>();
  let total = 0;
  const items: RetrievedMemory[] = picked.map((p) => {
    counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
    total += p.estimatedTokens;
    return {
      kind: p.kind,
      id: p.id,
      relevance: p.relevance,
      estimatedTokens: p.estimatedTokens,
      payload: p.payload as MemoryPayloadMap[typeof p.kind],
    } as RetrievedMemory;
  });
  const sources: MemoryRetrievalSourceCount[] = [];
  for (const [kind, count] of counts) sources.push({ kind, count });
  sources.sort((a, b) => a.kind.localeCompare(b.kind));
  return {
    query,
    items,
    totalEstimatedTokens: total,
    truncated,
    sources,
  };
}

export class MockMemoryRetriever implements MemoryRetriever {
  constructor(private snapshot: MemorySnapshot) {}

  async retrieve(query: MemoryRetrievalQuery): Promise<MemoryRetrievalResult> {
    const scorable = toScorable(this.snapshot);
    const filtered = query.kinds
      ? scorable.filter((s) => query.kinds!.includes(s.kind))
      : scorable;
    const ranked = rankMemoryItems(filtered, query);

    const maxItems = query.maxItems ?? MAX_ITEMS_DEFAULT;
    const budget = query.tokenBudget;

    const picked: { kind: MemoryEntityKind; id: string; relevance: number; estimatedTokens: number; payload: unknown }[] = [];
    let used = 0;
    let truncated = false;

    for (const it of ranked) {
      if (picked.length >= maxItems) {
        truncated = true;
        break;
      }
      if (used + it.estimatedTokens > budget) {
        truncated = true;
        continue;
      }
      picked.push({
        kind: it.kind,
        id: it.id,
        relevance: it.relevance,
        estimatedTokens: it.estimatedTokens,
        payload: it.payload,
      });
      used += it.estimatedTokens;
    }

    return buildResult(query, picked, truncated);
  }
}

export const MEMORY_SCHEMA_VERSIONS = {
  workspace: WORKSPACE_MEMORY_SCHEMA_VERSION,
  platform: PLATFORM_MEMORY_SCHEMA_VERSION,
  product: PRODUCT_MEMORY_SCHEMA_VERSION,
  account: ACCOUNT_MEMORY_SCHEMA_VERSION,
  historical_pattern: HISTORICAL_PATTERN_SCHEMA_VERSION,
  risk: RISK_MEMORY_SCHEMA_VERSION,
  ai_preference: AI_PREFERENCE_SCHEMA_VERSION,
  blocked_phrase: BLOCKED_PHRASE_SCHEMA_VERSION,
} as const;
