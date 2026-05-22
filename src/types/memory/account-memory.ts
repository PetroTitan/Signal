import type { SupportedChannel } from "@/core/platform-connections/platform-capabilities";

export const ACCOUNT_MEMORY_SCHEMA_VERSION = 1;

export type WarmupStage = "fresh" | "warming" | "established";

export interface AccountContentMixSlice {
  type: string;
  weight: number;
}

export interface AccountCooldownState {
  cooldownUntil: string | null;
  reason: string | null;
}

export interface AccountMemory {
  schemaVersion: number;
  accountId: string;
  platform: SupportedChannel;
  handle: string | null;
  role: "founder" | "team" | "support";
  cadenceScore: number;
  calmScore: number;
  healthScore: number;
  warmupStage: WarmupStage;
  preferredContentMix: AccountContentMixSlice[];
  recentRiskPatterns: string[];
  recentSuccessPatterns: string[];
  postingCooldownState: AccountCooldownState;
  lastUpdatedAt: string;
  active: boolean;
}

export const ACCOUNT_MEMORY_LIMITS = {
  recentRiskPatternsMax: 5,
  recentSuccessPatternsMax: 5,
  contentMixSlicesMax: 6,
  patternLengthMax: 120,
  serializedTargetBytes: 1024,
} as const;
