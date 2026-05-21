import type { PlatformId } from "./platform";

export type ActivityEventType =
  | "insight_created"
  | "opportunity_generated"
  | "draft_created"
  | "comment_drafted"
  | "thread_skipped"
  | "item_approved"
  | "item_rejected"
  | "item_backlogged"
  | "schedule_redistributed"
  | "risk_flagged"
  | "account_readiness_changed"
  | "discoverability_opportunity"
  | "account_created";

export type ActivityEntityType =
  | "insight"
  | "opportunity"
  | "draft"
  | "comment"
  | "discussion"
  | "weekly_item"
  | "backlog_item"
  | "schedule"
  | "risk"
  | "account"
  | "content_asset"
  | "discoverability";

export type ActivityLayer =
  | "core"
  | "platform_social"
  | "platform_search"
  | "intelligence"
  | "operations"
  | "configuration";

export type ActivitySeverity = "info" | "ok" | "warn" | "block";

export interface ActivityEvent {
  id: string;
  occurredAt: string;
  type: ActivityEventType;
  entityType: ActivityEntityType;
  layer: ActivityLayer;
  platform?: PlatformId | "google";
  productId?: string;
  severity: ActivitySeverity;
  title: string;
  explanation: string;
  link?: string;
}
