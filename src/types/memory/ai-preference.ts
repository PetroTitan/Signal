import type { AiUseCase } from "@/core/ai";

export const AI_PREFERENCE_SCHEMA_VERSION = 1;

export interface AiPreference {
  schemaVersion: number;
  id: string;
  useCase: AiUseCase;
  variantCount: 1 | 2 | 3;
  styleHint: string;
  blockedTokens: string[];
  preferredTokens: string[];
  lastUpdatedAt: string;
  active: boolean;
}

export const AI_PREFERENCE_LIMITS = {
  styleHintMax: 120,
  blockedTokensMax: 20,
  preferredTokensMax: 20,
  tokenLengthMax: 40,
  serializedTargetBytes: 512,
} as const;
