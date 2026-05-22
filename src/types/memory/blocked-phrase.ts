export const BLOCKED_PHRASE_SCHEMA_VERSION = 1;

export type BlockedPhraseScope = "workspace" | "product" | "platform";
export type BlockedPhraseSeverity = "soft" | "hard";

export interface BlockedPhrase {
  schemaVersion: number;
  id: string;
  phrase: string;
  scope: BlockedPhraseScope;
  scopeRefId: string;
  reason: string;
  severity: BlockedPhraseSeverity;
  lastUpdatedAt: string;
  active: boolean;
}

export const BLOCKED_PHRASE_LIMITS = {
  phraseLengthMax: 80,
  reasonLengthMax: 160,
  serializedTargetBytes: 256,
} as const;
