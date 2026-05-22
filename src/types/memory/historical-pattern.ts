import type { SupportedChannel } from "@/core/platform-connections/platform-capabilities";

export const HISTORICAL_PATTERN_SCHEMA_VERSION = 1;

export type HistoricalPatternKind =
  | "cadence"
  | "engagement"
  | "discoverability"
  | "risk"
  | "tone"
  | "platform_native";

export interface HistoricalPattern {
  schemaVersion: number;
  id: string;
  pattern: string;
  kind: HistoricalPatternKind;
  platform: SupportedChannel | "any";
  productId: string | null;
  confidence: number;
  supportingEvents: number;
  lastSeenAt: string;
  relevanceScore: number;
  active: boolean;
}

export const HISTORICAL_PATTERN_LIMITS = {
  patternLengthMax: 200,
  serializedTargetBytes: 512,
} as const;
