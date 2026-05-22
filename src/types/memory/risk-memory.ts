import type { SupportedChannel } from "@/core/platform-connections/platform-capabilities";

export const RISK_MEMORY_SCHEMA_VERSION = 1;

export type RiskMemorySeverity = "low" | "medium" | "high" | "blocked";

export interface RiskMemory {
  schemaVersion: number;
  id: string;
  riskPattern: string;
  severity: RiskMemorySeverity;
  platform: SupportedChannel | "any";
  triggerExamples: string[];
  recommendedFix: string;
  blockedAction: boolean;
  cooldownRecommendationHours: number | null;
  lastUpdatedAt: string;
  active: boolean;
}

export const RISK_MEMORY_LIMITS = {
  riskPatternMax: 160,
  recommendedFixMax: 240,
  triggerExamplesMax: 4,
  triggerLengthMax: 120,
  serializedTargetBytes: 1024,
} as const;
