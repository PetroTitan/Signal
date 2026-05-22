/**
 * Hand-written DB types for Phase C. When `supabase gen types` becomes
 * part of the workflow, replace this file with the generated output and
 * update the imports.
 */

export type WorkspaceRole = "owner" | "admin" | "editor" | "reviewer" | "viewer";

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceInsert {
  id?: string;
  name: string;
  slug?: string | null;
  created_by: string;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
}

export interface WorkspaceMemberInsert {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
}

export interface ProductRow {
  id: string;
  workspace_id: string;
  name: string;
  domain: string | null;
  summary: string | null;
  category: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ProductInsert {
  id?: string;
  workspace_id: string;
  name: string;
  domain?: string | null;
  summary?: string | null;
  category?: string | null;
  status?: string;
}

export interface ProductUpdate {
  name?: string;
  domain?: string | null;
  summary?: string | null;
  category?: string | null;
  status?: string;
}

export interface GrowthAccountRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  platform: string;
  handle: string | null;
  display_name: string | null;
  role: string | null;
  status: string;
  connection_status: string;
  created_at: string;
  updated_at: string;
}

export interface GrowthAccountInsert {
  id?: string;
  workspace_id: string;
  product_id?: string | null;
  platform: string;
  handle?: string | null;
  display_name?: string | null;
  role?: string | null;
  status?: string;
  connection_status?: string;
}

export interface GrowthAccountUpdate {
  product_id?: string | null;
  handle?: string | null;
  display_name?: string | null;
  role?: string | null;
  status?: string;
  connection_status?: string;
}

export interface WorkspaceSettingsRow {
  workspace_id: string;
  region: string | null;
  timezone: string | null;
  language: string | null;
  demo_mode: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceSettingsInsert {
  workspace_id: string;
  region?: string | null;
  timezone?: string | null;
  language?: string | null;
  demo_mode?: boolean;
}

export interface WorkspaceSettingsUpdate {
  region?: string | null;
  timezone?: string | null;
  language?: string | null;
  demo_mode?: boolean;
}

export interface ActivityEventRow {
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ActivityEventInsert {
  id?: string;
  workspace_id: string;
  actor_user_id?: string | null;
  event_type: string;
  entity_type?: string | null;
  entity_id?: string | null;
  title: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

// =====================================================================
// Phase D rows
// =====================================================================

export type WeeklyPlanStatus = "draft" | "review" | "approved" | "archived";

export interface WeeklyPlanRow {
  id: string;
  workspace_id: string;
  title: string;
  week_start: string;
  status: WeeklyPlanStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WeeklyPlanInsert {
  id?: string;
  workspace_id: string;
  title: string;
  week_start: string;
  status?: WeeklyPlanStatus;
  created_by?: string | null;
}

export interface WeeklyPlanUpdate {
  title?: string;
  week_start?: string;
  status?: WeeklyPlanStatus;
}

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

export interface WeeklyPlanItemRow {
  id: string;
  workspace_id: string;
  weekly_plan_id: string;
  product_id: string | null;
  account_id: string | null;
  platform: string | null;
  content_type: string | null;
  title: string | null;
  body: string | null;
  cta: string | null;
  link_url: string | null;
  status: WeeklyPlanItemStatus;
  risk_level: RiskLevel | null;
  risk_score: number | null;
  scheduled_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WeeklyPlanItemInsert {
  id?: string;
  workspace_id: string;
  weekly_plan_id: string;
  product_id?: string | null;
  account_id?: string | null;
  platform?: string | null;
  content_type?: string | null;
  title?: string | null;
  body?: string | null;
  cta?: string | null;
  link_url?: string | null;
  status?: WeeklyPlanItemStatus;
  risk_level?: RiskLevel | null;
  risk_score?: number | null;
  scheduled_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WeeklyPlanItemUpdate {
  product_id?: string | null;
  account_id?: string | null;
  platform?: string | null;
  content_type?: string | null;
  title?: string | null;
  body?: string | null;
  cta?: string | null;
  link_url?: string | null;
  status?: WeeklyPlanItemStatus;
  risk_level?: RiskLevel | null;
  risk_score?: number | null;
  scheduled_at?: string | null;
  metadata?: Record<string, unknown>;
}

export type ApprovalAction =
  | "approve"
  | "reject"
  | "send_to_backlog"
  | "restore_from_backlog"
  | "rewrite_softer"
  | "convert_to_comment"
  | "remove_link"
  | "schedule"
  | "pause"
  | "unschedule"
  | "delay";

export interface ApprovalEventRow {
  id: string;
  workspace_id: string;
  weekly_plan_item_id: string | null;
  actor_user_id: string | null;
  action: ApprovalAction;
  note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ApprovalEventInsert {
  id?: string;
  workspace_id: string;
  weekly_plan_item_id?: string | null;
  actor_user_id?: string | null;
  action: ApprovalAction;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

export type BacklogItemStatus = "backlog" | "restored" | "archived";

export interface BacklogItemRow {
  id: string;
  workspace_id: string;
  source_item_id: string | null;
  product_id: string | null;
  account_id: string | null;
  platform: string | null;
  title: string | null;
  body: string | null;
  reason: string | null;
  status: BacklogItemStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BacklogItemInsert {
  id?: string;
  workspace_id: string;
  source_item_id?: string | null;
  product_id?: string | null;
  account_id?: string | null;
  platform?: string | null;
  title?: string | null;
  body?: string | null;
  reason?: string | null;
  status?: BacklogItemStatus;
  metadata?: Record<string, unknown>;
}

export interface BacklogItemUpdate {
  status?: BacklogItemStatus;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export type ScheduledItemStatus = "scheduled" | "paused" | "published" | "cancelled";

export interface ScheduledItemRow {
  id: string;
  workspace_id: string;
  weekly_plan_item_id: string | null;
  product_id: string | null;
  account_id: string | null;
  platform: string | null;
  scheduled_at: string;
  status: ScheduledItemStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ScheduledItemInsert {
  id?: string;
  workspace_id: string;
  weekly_plan_item_id?: string | null;
  product_id?: string | null;
  account_id?: string | null;
  platform?: string | null;
  scheduled_at: string;
  status?: ScheduledItemStatus;
  metadata?: Record<string, unknown>;
}

export interface ScheduledItemUpdate {
  scheduled_at?: string;
  status?: ScheduledItemStatus;
  metadata?: Record<string, unknown>;
}

export interface RiskEventRow {
  id: string;
  workspace_id: string;
  entity_type: string;
  entity_id: string | null;
  risk_level: RiskLevel;
  risk_score: number | null;
  reason: string;
  recommendation: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface RiskEventInsert {
  id?: string;
  workspace_id: string;
  entity_type: string;
  entity_id?: string | null;
  risk_level: RiskLevel;
  risk_score?: number | null;
  reason: string;
  recommendation?: string | null;
  metadata?: Record<string, unknown>;
}

export type DraftVariantStatus = "draft" | "selected" | "discarded";

export interface DraftVariantRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  weekly_plan_item_id: string | null;
  platform: string | null;
  variant_type: string | null;
  title: string | null;
  body: string;
  status: DraftVariantStatus;
  risk_level: RiskLevel | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DraftVariantInsert {
  id?: string;
  workspace_id: string;
  product_id?: string | null;
  weekly_plan_item_id?: string | null;
  platform?: string | null;
  variant_type?: string | null;
  title?: string | null;
  body: string;
  status?: DraftVariantStatus;
  risk_level?: RiskLevel | null;
  metadata?: Record<string, unknown>;
}

export interface DraftVariantUpdate {
  title?: string | null;
  body?: string;
  status?: DraftVariantStatus;
  risk_level?: RiskLevel | null;
  metadata?: Record<string, unknown>;
}

export interface Database {
  public: {
    Tables: {
      workspaces: {
        Row: WorkspaceRow;
        Insert: WorkspaceInsert;
        Update: Partial<WorkspaceInsert>;
        Relationships: [];
      };
      workspace_members: {
        Row: WorkspaceMemberRow;
        Insert: WorkspaceMemberInsert;
        Update: Partial<WorkspaceMemberInsert>;
        Relationships: [];
      };
      products: {
        Row: ProductRow;
        Insert: ProductInsert;
        Update: ProductUpdate;
        Relationships: [];
      };
      growth_accounts: {
        Row: GrowthAccountRow;
        Insert: GrowthAccountInsert;
        Update: GrowthAccountUpdate;
        Relationships: [];
      };
      workspace_settings: {
        Row: WorkspaceSettingsRow;
        Insert: WorkspaceSettingsInsert;
        Update: WorkspaceSettingsUpdate;
        Relationships: [];
      };
      activity_events: {
        Row: ActivityEventRow;
        Insert: ActivityEventInsert;
        Update: Partial<ActivityEventInsert>;
        Relationships: [];
      };
      weekly_plans: {
        Row: WeeklyPlanRow;
        Insert: WeeklyPlanInsert;
        Update: WeeklyPlanUpdate;
        Relationships: [];
      };
      weekly_plan_items: {
        Row: WeeklyPlanItemRow;
        Insert: WeeklyPlanItemInsert;
        Update: WeeklyPlanItemUpdate;
        Relationships: [];
      };
      approval_events: {
        Row: ApprovalEventRow;
        Insert: ApprovalEventInsert;
        Update: Partial<ApprovalEventInsert>;
        Relationships: [];
      };
      backlog_items: {
        Row: BacklogItemRow;
        Insert: BacklogItemInsert;
        Update: BacklogItemUpdate;
        Relationships: [];
      };
      scheduled_items: {
        Row: ScheduledItemRow;
        Insert: ScheduledItemInsert;
        Update: ScheduledItemUpdate;
        Relationships: [];
      };
      risk_events: {
        Row: RiskEventRow;
        Insert: RiskEventInsert;
        Update: Partial<RiskEventInsert>;
        Relationships: [];
      };
      draft_variants: {
        Row: DraftVariantRow;
        Insert: DraftVariantInsert;
        Update: DraftVariantUpdate;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
  };
}
