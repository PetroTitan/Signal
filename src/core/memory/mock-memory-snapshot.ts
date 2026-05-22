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
import type { MemorySnapshot } from "./memory-retriever";

const NOW = "2026-01-01T00:00:00.000Z";

export const MOCK_MEMORY_SNAPSHOT: MemorySnapshot = {
  workspaces: [
    {
      schemaVersion: WORKSPACE_MEMORY_SCHEMA_VERSION,
      workspaceId: "ws_helperg",
      workspaceName: "Helperg",
      tone: "warm",
      communicationStyle: "founder_first_person",
      promotionLevel: "minimal",
      riskTolerance: "low",
      linkPolicy: "platform_native",
      cadencePolicy: "calm",
      preferredPlatforms: ["reddit", "x", "linkedin"],
      blockedPhrases: ["10x", "game-changer", "revolutionary"],
      preferredPhrases: ["what we learned", "from our experience"],
      writingStyleSummary:
        "Calm, founder-first, specific. Stories over claims. No marketing tone.",
      operationalSummary:
        "Weekly approval, calm cadence, platform-native participation only.",
      lastUpdatedAt: NOW,
      source: "default",
      active: true,
    },
  ],
  platforms: [
    {
      schemaVersion: PLATFORM_MEMORY_SCHEMA_VERSION,
      platform: "reddit",
      preferredStyle: "Discussion-first. Stories and lessons.",
      preferredFormats: ["comment", "text_post"],
      blockedBehaviors: ["direct_link_first", "marketing_tone", "ask_for_dm"],
      cadenceRules: {
        minHoursBetween: 18,
        weeklyTargetMin: 2,
        weeklyTargetMax: 4,
      },
      linkRules: {
        allowDirectLinks: false,
        contextRequired: true,
        maxLinkRatio: 0.25,
      },
      toneRules: ["match subreddit voice", "answer the question first"],
      antiSpamRules: ["no repeated talking points across threads"],
      engagementRiskRules: ["no engagement bait", "no fake humility"],
      lastUpdatedAt: NOW,
      active: true,
    },
    {
      schemaVersion: PLATFORM_MEMORY_SCHEMA_VERSION,
      platform: "x",
      preferredStyle: "Short, specific, one idea per post.",
      preferredFormats: ["short_post", "reply"],
      blockedBehaviors: ["thread_padding", "growth_hack_tone"],
      cadenceRules: {
        minHoursBetween: 8,
        weeklyTargetMin: 3,
        weeklyTargetMax: 7,
      },
      linkRules: {
        allowDirectLinks: true,
        contextRequired: true,
        maxLinkRatio: 0.33,
      },
      toneRules: ["no first-person CTA pile-ups"],
      antiSpamRules: ["no reply guying"],
      engagementRiskRules: ["no rage-bait"],
      lastUpdatedAt: NOW,
      active: true,
    },
    {
      schemaVersion: PLATFORM_MEMORY_SCHEMA_VERSION,
      platform: "linkedin",
      preferredStyle: "Reflective, specific, calm.",
      preferredFormats: ["text_post", "comment"],
      blockedBehaviors: ["broetry", "humble_brag"],
      cadenceRules: {
        minHoursBetween: 24,
        weeklyTargetMin: 1,
        weeklyTargetMax: 3,
      },
      linkRules: {
        allowDirectLinks: true,
        contextRequired: true,
        maxLinkRatio: 0.25,
      },
      toneRules: ["concrete stories", "no platitudes"],
      antiSpamRules: ["no repeated frameworks"],
      engagementRiskRules: ["no comment baiting"],
      lastUpdatedAt: NOW,
      active: true,
    },
    {
      schemaVersion: PLATFORM_MEMORY_SCHEMA_VERSION,
      platform: "google",
      preferredStyle: "Search-intent matched. Specific page topics.",
      preferredFormats: ["evergreen", "topic_cluster"],
      blockedBehaviors: ["thin_content", "keyword_stuffing"],
      cadenceRules: { minHoursBetween: 0, weeklyTargetMin: 0, weeklyTargetMax: 0 },
      linkRules: {
        allowDirectLinks: true,
        contextRequired: false,
        maxLinkRatio: 1,
      },
      toneRules: ["match query intent"],
      antiSpamRules: ["no duplicate pages"],
      engagementRiskRules: [],
      lastUpdatedAt: NOW,
      active: true,
    },
  ],
  products: [],
  accounts: [],
  patterns: [
    {
      schemaVersion: HISTORICAL_PATTERN_SCHEMA_VERSION,
      id: "pat_reddit_no_link_first",
      pattern: "reddit_comments_without_links_perform_better",
      kind: "engagement",
      platform: "reddit",
      productId: null,
      confidence: 0.81,
      supportingEvents: 12,
      lastSeenAt: NOW,
      relevanceScore: 0.72,
      active: true,
    },
  ],
  risks: [
    {
      schemaVersion: RISK_MEMORY_SCHEMA_VERSION,
      id: "risk_reddit_link_first",
      riskPattern: "Leading with a product link in a Reddit comment",
      severity: "high",
      platform: "reddit",
      triggerExamples: [
        "Check out our site for more...",
        "Here's our app: ...",
      ],
      recommendedFix:
        "Answer the question first. Link only if a user asks for the resource.",
      blockedAction: false,
      cooldownRecommendationHours: 24,
      lastUpdatedAt: NOW,
      active: true,
    },
  ],
  aiPreferences: [
    {
      schemaVersion: AI_PREFERENCE_SCHEMA_VERSION,
      id: "pref_default_softer",
      useCase: "rewrite_softer",
      variantCount: 2,
      styleHint: "Conversational, specific, no superlatives.",
      blockedTokens: ["unlock", "10x", "revolutionary"],
      preferredTokens: ["specifically", "in our case"],
      lastUpdatedAt: NOW,
      active: true,
    },
  ],
  blockedPhrases: [
    {
      schemaVersion: BLOCKED_PHRASE_SCHEMA_VERSION,
      id: "bp_revolutionary",
      phrase: "revolutionary",
      scope: "workspace",
      scopeRefId: "ws_helperg",
      reason: "Avoid superlatives. Be specific instead.",
      severity: "hard",
      lastUpdatedAt: NOW,
      active: true,
    },
  ],
};

export const ACCOUNT_MEMORY_DEFAULTS = {
  schemaVersion: ACCOUNT_MEMORY_SCHEMA_VERSION,
} as const;

export const PRODUCT_MEMORY_DEFAULTS = {
  schemaVersion: PRODUCT_MEMORY_SCHEMA_VERSION,
} as const;
