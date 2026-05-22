import type { SupportedChannel } from "@/core/platform-connections/platform-capabilities";

export const PLATFORM_MEMORY_SCHEMA_VERSION = 1;

export interface PlatformMemoryCadenceRules {
  minHoursBetween: number;
  weeklyTargetMin: number;
  weeklyTargetMax: number;
}

export interface PlatformMemoryLinkRules {
  allowDirectLinks: boolean;
  contextRequired: boolean;
  maxLinkRatio: number;
}

export interface PlatformMemory {
  schemaVersion: number;
  platform: SupportedChannel;
  preferredStyle: string;
  preferredFormats: string[];
  blockedBehaviors: string[];
  cadenceRules: PlatformMemoryCadenceRules;
  linkRules: PlatformMemoryLinkRules;
  toneRules: string[];
  antiSpamRules: string[];
  engagementRiskRules: string[];
  lastUpdatedAt: string;
  active: boolean;
}

export const PLATFORM_MEMORY_LIMITS = {
  preferredStyleMax: 200,
  ruleStringMax: 120,
  rulesArrayMax: 8,
  serializedTargetBytes: 1024,
} as const;
