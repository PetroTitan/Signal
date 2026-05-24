/**
 * publishing-qa — typed surface.
 *
 * This module exists to orchestrate the existing publishing
 * primitives (safety rules, guardrails, fingerprint, risk score,
 * account health policy) into a single deterministic Draft QA pass.
 * It owns no domain logic of its own beyond:
 *
 *   - near-duplicate detection (Jaccard on token shingles)
 *   - topic-platform affinity classification (keyword-based)
 *   - new-account safety caps (derived from existing policy constants)
 *   - ecosystem derivative mapping (canonical idea → legal child posts)
 *
 * Everything here is pure: no I/O, no DB, no AI provider calls. The
 * caller assembles the input from repositories; the orchestrator
 * returns a verdict.
 */

import type { FounderPlatform } from "@/core/publishing/platform-guidance";

// =====================================================================
// Identity + draft inputs
// =====================================================================

/**
 * The minimum identity surface QA needs. Anything richer should be
 * derived from this; we deliberately keep the contract narrow so the
 * caller doesn't have to load the full growth_accounts row.
 */
export interface QaIdentity {
  platform: FounderPlatform;
  /** Account age in days. Drives new-account safety caps. */
  ageDays: number;
  /** Display name — only used for human-readable findings. */
  displayName: string;
  /** Optional handle for human-readable findings. */
  handle: string | null;
  /** Account lifecycle status from growth_accounts.status. */
  status:
    | "planned"
    | "warming"
    | "active"
    | "paused"
    | "setup_needed"
    | "awaiting_manual_creation"
    | "archived";
}

/**
 * The draft under review. Hook/body/cta split mirrors the existing
 * draft schema; flat-text callers can pass the whole post as `body`
 * with an empty `hook`.
 */
export interface QaDraft {
  hook: string;
  body: string;
  cta: string | null;
  /** Outbound link count — caller computes from the draft body. */
  outboundLinkCount: number;
  /** Hashtag count. */
  hashtagCount: number;
  /** Did the caller flag this as a thread/multi-part post? */
  isThread: boolean;
}

/**
 * Recent history the orchestrator scans for near-duplicates. The
 * caller assembles this from `publish_history` + `weekly_plan_items`
 * — QA itself doesn't read the DB.
 */
export interface QaRecentPost {
  platform: FounderPlatform;
  hook: string;
  body: string;
  /** ISO timestamp. */
  publishedAt: string;
}

export interface QaInput {
  identity: QaIdentity;
  draft: QaDraft;
  /** Up to ~50 recent posts is enough for deterministic dedup. */
  recentHistory: ReadonlyArray<QaRecentPost>;
  /** Optional: topic kind if the caller already classified. */
  topicKind?: TopicKind;
}

// =====================================================================
// Verdict + findings
// =====================================================================

export type QaSeverity = "info" | "warn" | "block";

export type QaCategory =
  | "safety" // banned phrases, fabrication patterns
  | "guardrail" // CTA aggression, AI voice, launch language, fake certainty
  | "duplicate" // exact or near-duplicate of prior content
  | "topic_fit" // wrong platform for this topic kind
  | "new_account" // warming-account caps violated
  | "link_safety" // too many outbound links for the platform/age
  | "structure" // thread on a platform that discourages threads, etc.
  | "cross_platform_copypaste"; // same hook/CTA/structure as a sibling-platform draft

export interface QaFinding {
  category: QaCategory;
  severity: QaSeverity;
  /** Machine-readable code for tests / future routing. */
  code: string;
  /** Single human-readable sentence. */
  message: string;
  /** Optional: similar text the duplicate-checker matched against. */
  evidence?: string;
}

export type QaVerdict = "pass" | "warn" | "block";

export interface QaResult {
  verdict: QaVerdict;
  findings: ReadonlyArray<QaFinding>;
  /**
   * Convenience: filtered subsets so the UI doesn't have to re-walk.
   */
  blocks: ReadonlyArray<QaFinding>;
  warnings: ReadonlyArray<QaFinding>;
  infos: ReadonlyArray<QaFinding>;
}

// =====================================================================
// Topic ownership
// =====================================================================

/**
 * Coarse classification of what kind of content a draft is. The
 * topic-matrix table maps each kind to an affinity per platform.
 */
export type TopicKind =
  | "operational_observation"
  | "reflective_commentary"
  | "founder_observation"
  | "visual_storytelling"
  | "industry_summary"
  | "engineering_article"
  | "architecture_deep_dive"
  | "discussion_question"
  | "operator_lesson"
  | "changelog"
  | "long_form_explainer"
  | "launch_announcement"
  | "promotional";

export type TopicAffinity =
  | "native" // platform's home turf
  | "derivative" // ok if transformed to platform-native shape
  | "discouraged" // possible but unusual; warn
  | "forbidden"; // never publish; block

// =====================================================================
// New-account caps
// =====================================================================

export interface NewAccountCaps {
  isNewAccount: boolean;
  /** Max items per week before warming windows are violated. */
  maxItemsPerWeek: number;
  /** Max outbound links per item. */
  maxOutboundLinksPerItem: number;
  /** Block multi-part threads while warming. */
  allowThreads: boolean;
  /** Block launch-language while warming. */
  allowLaunchLanguage: boolean;
  /** Block hashtag spam (anything > this count). */
  maxHashtagsPerItem: number;
  /** Days until the account leaves warm-up mode. */
  warmUpDaysRemaining: number;
}
