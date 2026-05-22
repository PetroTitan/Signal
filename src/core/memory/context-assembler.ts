import type {
  AccountMemory,
  BlockedPhrase,
  HistoricalPattern,
  MemoryRetrievalResult,
  PlatformMemory,
  ProductMemory,
  RetrievedMemory,
  RiskMemory,
  WorkspaceMemory,
} from "@/types/memory";
import type { AiUseCase } from "@/core/ai";
import { estimateTokens, getBudget, withinBudget, type TokenBudget } from "./token-budget";

export type ContextLayerKind =
  | "system"
  | "workspace"
  | "platform"
  | "product"
  | "account"
  | "insight"
  | "risk"
  | "constraints";

export interface ContextLayer {
  kind: ContextLayerKind;
  estimatedTokens: number;
  content: string;
}

export interface AssembledContext {
  taskType: AiUseCase;
  budget: TokenBudget;
  estimatedTokens: number;
  layers: ContextLayer[];
  truncated: boolean;
  warning: string | null;
  sourceCount: number;
}

const SYSTEM_LAYER_TEXT =
  "Signal: human-approved growth ops. No autonomous publishing. " +
  "No fake metrics. Output must respect product, platform, and risk constraints.";

function workspaceLayer(w: WorkspaceMemory): string {
  return [
    `tone=${w.tone}`,
    `style=${w.communicationStyle}`,
    `promotion=${w.promotionLevel}`,
    `risk=${w.riskTolerance}`,
    `link=${w.linkPolicy}`,
    `cadence=${w.cadencePolicy}`,
    w.writingStyleSummary ? `style_note=${w.writingStyleSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function platformLayer(p: PlatformMemory): string {
  return [
    `platform=${p.platform}`,
    `style=${p.preferredStyle}`,
    `formats=${p.preferredFormats.join(",")}`,
    `blocked=${p.blockedBehaviors.join(",")}`,
    `link_allow=${p.linkRules.allowDirectLinks}`,
    `link_context_required=${p.linkRules.contextRequired}`,
    `max_link_ratio=${p.linkRules.maxLinkRatio}`,
    `cadence_min_hours=${p.cadenceRules.minHoursBetween}`,
  ].join("\n");
}

function productLayer(pr: ProductMemory): string {
  return [
    `product=${pr.productName}`,
    `summary=${pr.shortSummary}`,
    `audience=${pr.audience}`,
    `positioning=${pr.positioning}`,
    `allowed=${pr.allowedTopics.slice(0, 8).join(",")}`,
    `blocked=${pr.blockedTopics.slice(0, 8).join(",")}`,
    `claims=${pr.claimRestrictions.slice(0, 4).join(",")}`,
  ].join("\n");
}

function accountLayer(a: AccountMemory): string {
  return [
    `account=${a.handle ?? a.accountId}`,
    `platform=${a.platform}`,
    `warmup=${a.warmupStage}`,
    `cadence_score=${a.cadenceScore}`,
    `calm_score=${a.calmScore}`,
    `health_score=${a.healthScore}`,
    a.postingCooldownState.cooldownUntil
      ? `cooldown_until=${a.postingCooldownState.cooldownUntil}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function insightLayer(h: HistoricalPattern): string {
  return `pattern[${h.kind}/${h.platform}]: ${h.pattern} (conf=${h.confidence}, n=${h.supportingEvents})`;
}

function riskLayer(r: RiskMemory): string {
  return `risk[${r.severity}/${r.platform}]: ${r.riskPattern} → ${r.recommendedFix}`;
}

function blockedLayer(b: BlockedPhrase): string {
  return `blocked[${b.severity}/${b.scope}]: "${b.phrase}" — ${b.reason}`;
}

function packLayer(kind: ContextLayerKind, content: string): ContextLayer {
  return { kind, estimatedTokens: estimateTokens(content), content };
}

export interface AssembleOptions {
  taskType: AiUseCase;
  retrieval: MemoryRetrievalResult;
}

export function assembleContext(opts: AssembleOptions): AssembledContext {
  const budget = getBudget(opts.taskType);
  const layers: ContextLayer[] = [packLayer("system", SYSTEM_LAYER_TEXT)];

  const grouped: Record<string, RetrievedMemory[]> = {};
  for (const it of opts.retrieval.items) {
    (grouped[it.kind] ?? (grouped[it.kind] = [])).push(it);
  }

  if (grouped.workspace) {
    for (const it of grouped.workspace) {
      layers.push(packLayer("workspace", workspaceLayer(it.payload as WorkspaceMemory)));
    }
  }
  if (grouped.platform) {
    for (const it of grouped.platform) {
      layers.push(packLayer("platform", platformLayer(it.payload as PlatformMemory)));
    }
  }
  if (grouped.product) {
    for (const it of grouped.product) {
      layers.push(packLayer("product", productLayer(it.payload as ProductMemory)));
    }
  }
  if (grouped.account) {
    for (const it of grouped.account) {
      layers.push(packLayer("account", accountLayer(it.payload as AccountMemory)));
    }
  }
  if (grouped.historical_pattern) {
    for (const it of grouped.historical_pattern) {
      layers.push(packLayer("insight", insightLayer(it.payload as HistoricalPattern)));
    }
  }
  if (grouped.risk) {
    for (const it of grouped.risk) {
      layers.push(packLayer("risk", riskLayer(it.payload as RiskMemory)));
    }
  }
  if (grouped.blocked_phrase) {
    const lines = grouped.blocked_phrase
      .map((it) => blockedLayer(it.payload as BlockedPhrase))
      .join("\n");
    if (lines) layers.push(packLayer("constraints", lines));
  }

  const estimatedTokens = layers.reduce((s, l) => s + l.estimatedTokens, 0);
  const check = withinBudget(budget, estimatedTokens);

  return {
    taskType: opts.taskType,
    budget,
    estimatedTokens,
    layers,
    truncated: opts.retrieval.truncated || !check.ok,
    warning: check.reason ?? null,
    sourceCount: opts.retrieval.items.length,
  };
}
