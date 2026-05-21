import type { PlatformId } from "./platform";

export type ContentType =
  | "discussion_post"
  | "tutorial"
  | "case_study"
  | "comment_reply"
  | "thread"
  | "announcement"
  | "long_form_article";

export type WeeklyPlanItemStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "scheduled"
  | "published"
  | "skipped"
  | "backlog"
  | "paused";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

export interface RiskScore {
  score: number;
  level: RiskLevel;
  reasons: string[];
  recommendation: string;
}

export interface ContentDraft {
  id: string;
  hook: string;
  body: string;
  cta: string | null;
  trackingLinkId: string | null;
}

export interface WeeklyPlanItem {
  id: string;
  planId: string;
  accountId: string;
  productId: string;
  platform: PlatformId;
  contentType: ContentType;
  draft: ContentDraft;
  scheduledFor: string;
  status: WeeklyPlanItemStatus;
  risk: RiskScore;
}

export interface WeeklyPlan {
  id: string;
  workspaceId: string;
  weekStartIso: string;
  weekEndIso: string;
  status: "drafting" | "awaiting_approval" | "approved" | "in_progress" | "complete";
}

export interface BacklogItem {
  id: string;
  workspaceId: string;
  accountId: string;
  productId: string;
  platform: PlatformId;
  contentType: ContentType;
  draft: ContentDraft;
  risk: RiskScore;
  movedFromPlanItemId: string | null;
  reason: string;
  movedAt: string;
}
