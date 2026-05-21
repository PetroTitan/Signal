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
  | "backlog";

export type RiskLevel = "low" | "medium" | "high";

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
  riskLevel: RiskLevel;
  riskNotes: string[];
}

export interface WeeklyPlan {
  id: string;
  workspaceId: string;
  weekStartIso: string;
  weekEndIso: string;
  itemCount: number;
  approvedCount: number;
  pendingCount: number;
  status: "drafting" | "awaiting_approval" | "approved" | "in_progress" | "complete";
}
