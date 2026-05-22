export const WORKSPACE_MEMORY_SCHEMA_VERSION = 1;

export type WorkspaceTone = "warm" | "neutral" | "direct" | "playful";
export type WorkspaceCommunicationStyle =
  | "founder_first_person"
  | "team_voice"
  | "conversational"
  | "expert";
export type WorkspacePromotionLevel = "minimal" | "balanced" | "moderate";
export type WorkspaceRiskTolerance = "low" | "medium" | "high";
export type WorkspaceLinkPolicy = "platform_native" | "rare" | "off";
export type WorkspaceCadencePolicy = "calm" | "regular" | "active";
export type MemorySource = "user" | "derived" | "default";

export interface WorkspaceMemory {
  schemaVersion: number;
  workspaceId: string;
  workspaceName: string;
  tone: WorkspaceTone;
  communicationStyle: WorkspaceCommunicationStyle;
  promotionLevel: WorkspacePromotionLevel;
  riskTolerance: WorkspaceRiskTolerance;
  linkPolicy: WorkspaceLinkPolicy;
  cadencePolicy: WorkspaceCadencePolicy;
  preferredPlatforms: string[];
  blockedPhrases: string[];
  preferredPhrases: string[];
  writingStyleSummary: string;
  operationalSummary: string;
  lastUpdatedAt: string;
  source: MemorySource;
  active: boolean;
}

export const WORKSPACE_MEMORY_LIMITS = {
  preferredPlatformsMax: 4,
  blockedPhrasesMax: 20,
  preferredPhrasesMax: 20,
  phraseLengthMax: 64,
  writingStyleSummaryMax: 240,
  operationalSummaryMax: 240,
  serializedTargetBytes: 2048,
} as const;
