import type { SupportedChannel } from "@/core/platform-connections/platform-capabilities";
import type { MemorySource } from "./workspace-memory";

export const PRODUCT_MEMORY_SCHEMA_VERSION = 1;

export interface ProductMemory {
  schemaVersion: number;
  productId: string;
  productName: string;
  shortSummary: string;
  audience: string;
  allowedTopics: string[];
  blockedTopics: string[];
  positioning: string;
  proofConstraints: string[];
  claimRestrictions: string[];
  platformFit: SupportedChannel[];
  contentAngles: string[];
  evergreenTopics: string[];
  lastUpdatedAt: string;
  source: MemorySource;
  active: boolean;
}

export const PRODUCT_MEMORY_LIMITS = {
  shortSummaryMax: 280,
  audienceMax: 200,
  positioningMax: 240,
  allowedTopicsMax: 15,
  blockedTopicsMax: 15,
  proofConstraintsMax: 10,
  claimRestrictionsMax: 10,
  contentAnglesMax: 10,
  evergreenTopicsMax: 10,
  topicLengthMax: 64,
  serializedTargetBytes: 2048,
} as const;
