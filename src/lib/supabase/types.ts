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
  source: string;
  review_status: string;
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
  source?: string;
  review_status?: string;
}

export interface ProductUpdate {
  name?: string;
  domain?: string | null;
  summary?: string | null;
  category?: string | null;
  status?: string;
  source?: string;
  review_status?: string;
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
  source: string;
  review_status: string;
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
  source?: string;
  review_status?: string;
}

export interface GrowthAccountUpdate {
  product_id?: string | null;
  handle?: string | null;
  display_name?: string | null;
  role?: string | null;
  status?: string;
  connection_status?: string;
  source?: string;
  review_status?: string;
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
  source: string;
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
  source?: string;
  operation_id?: string | null;
  review_status?: string | null;
}

// =====================================================================
// MCP operations layer
// =====================================================================

export interface McpOperationRunRow {
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  operation_type: string;
  risk_level: string;
  approval_mode: string;
  status: string;
  input_summary: string | null;
  output_summary: string | null;
  error_summary: string | null;
  requires_user_approval: boolean;
  approved_at: string | null;
  approved_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface McpOperationRunInsert {
  id?: string;
  workspace_id: string;
  actor_user_id?: string | null;
  operation_type: string;
  risk_level: string;
  approval_mode: string;
  status?: string;
  input_summary?: string | null;
  output_summary?: string | null;
  error_summary?: string | null;
  requires_user_approval?: boolean;
  approved_at?: string | null;
  approved_by?: string | null;
  metadata?: Record<string, unknown>;
}

export interface McpOperationRunUpdate {
  status?: string;
  input_summary?: string | null;
  output_summary?: string | null;
  error_summary?: string | null;
  requires_user_approval?: boolean;
  approved_at?: string | null;
  approved_by?: string | null;
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

// Phase F1 — creative assets attached to weekly_plan_items.

export type CreativeType = "image" | "video" | "animation";
export type CreativeSourceType =
  | "generated"
  | "uploaded"
  | "wikimedia"
  | "official_source"
  | "manual_url"
  | "planned";
export type CreativeStatus =
  | "planned"
  | "pending_review"
  | "approved"
  | "rejected";

export interface WeeklyPlanItemCreativeRow {
  id: string;
  workspace_id: string;
  weekly_plan_item_id: string;
  creative_type: CreativeType;
  source_type: CreativeSourceType;
  source_url: string | null;
  asset_url: string | null;
  prompt: string | null;
  alt_text: string | null;
  license: string | null;
  attribution: string | null;
  risk_notes: string | null;
  status: CreativeStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WeeklyPlanItemCreativeInsert {
  id?: string;
  workspace_id: string;
  weekly_plan_item_id: string;
  creative_type: CreativeType;
  source_type: CreativeSourceType;
  source_url?: string | null;
  asset_url?: string | null;
  prompt?: string | null;
  alt_text?: string | null;
  license?: string | null;
  attribution?: string | null;
  risk_notes?: string | null;
  status?: CreativeStatus;
  metadata?: Record<string, unknown>;
}

export interface WeeklyPlanItemCreativeUpdate {
  creative_type?: CreativeType;
  source_type?: CreativeSourceType;
  source_url?: string | null;
  asset_url?: string | null;
  prompt?: string | null;
  alt_text?: string | null;
  license?: string | null;
  attribution?: string | null;
  risk_notes?: string | null;
  status?: CreativeStatus;
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

// =====================================================================
// Phase E1 — Weekly Operating Contract
// =====================================================================

export type WeeklyContractStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "active"
  | "paused"
  | "expired"
  | "revoked";

export type WeeklyContractRiskCeiling = "low" | "medium" | "high";

export type WeeklyContractActionType =
  | "publish_scheduled_post"
  | "publish_scheduled_comment"
  | "send_engagement_signal"
  | "mark_item_skipped"
  | "rotate_to_backlog"
  | "open_pr_for_review"
  | "request_screenshot_import"
  | "request_profile_suggestion";

export interface WeeklyApprovalContractRow {
  id: string;
  workspace_id: string;
  created_by: string | null;
  approved_by: string | null;
  title: string;
  week_start: string;
  week_end: string;
  status: WeeklyContractStatus;
  max_risk_level: WeeklyContractRiskCeiling;
  max_actions_total: number | null;
  max_actions_per_day: number | null;
  max_actions_per_platform_per_day: number | null;
  pause_on_first_failure: boolean;
  pause_on_risk_event: boolean;
  notes: string | null;
  approval_text_phrase: string | null;
  approved_at: string | null;
  activated_at: string | null;
  paused_at: string | null;
  expired_at: string | null;
  revoked_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WeeklyApprovalContractInsert {
  id?: string;
  workspace_id: string;
  created_by?: string | null;
  approved_by?: string | null;
  title: string;
  week_start: string;
  week_end: string;
  status?: WeeklyContractStatus;
  max_risk_level?: WeeklyContractRiskCeiling;
  max_actions_total?: number | null;
  max_actions_per_day?: number | null;
  max_actions_per_platform_per_day?: number | null;
  pause_on_first_failure?: boolean;
  pause_on_risk_event?: boolean;
  notes?: string | null;
  approval_text_phrase?: string | null;
  approved_at?: string | null;
  activated_at?: string | null;
  paused_at?: string | null;
  expired_at?: string | null;
  revoked_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WeeklyApprovalContractUpdate {
  title?: string;
  week_start?: string;
  week_end?: string;
  status?: WeeklyContractStatus;
  max_risk_level?: WeeklyContractRiskCeiling;
  max_actions_total?: number | null;
  max_actions_per_day?: number | null;
  max_actions_per_platform_per_day?: number | null;
  pause_on_first_failure?: boolean;
  pause_on_risk_event?: boolean;
  notes?: string | null;
  approval_text_phrase?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  activated_at?: string | null;
  paused_at?: string | null;
  expired_at?: string | null;
  revoked_at?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WeeklyContractAccountRow {
  contract_id: string;
  workspace_id: string;
  account_id: string;
  created_at: string;
}
export interface WeeklyContractAccountInsert {
  contract_id: string;
  workspace_id: string;
  account_id: string;
}

export interface WeeklyContractProductRow {
  contract_id: string;
  workspace_id: string;
  product_id: string;
  created_at: string;
}
export interface WeeklyContractProductInsert {
  contract_id: string;
  workspace_id: string;
  product_id: string;
}

export interface WeeklyContractPlatformRow {
  contract_id: string;
  workspace_id: string;
  platform: string;
  created_at: string;
}
export interface WeeklyContractPlatformInsert {
  contract_id: string;
  workspace_id: string;
  platform: string;
}

export interface WeeklyContractAllowedActionRow {
  contract_id: string;
  workspace_id: string;
  action_type: WeeklyContractActionType;
  created_at: string;
}
export interface WeeklyContractAllowedActionInsert {
  contract_id: string;
  workspace_id: string;
  action_type: WeeklyContractActionType;
}

export interface WeeklyContractExecutionWindowRow {
  id: string;
  contract_id: string;
  workspace_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  created_at: string;
}
export interface WeeklyContractExecutionWindowInsert {
  id?: string;
  contract_id: string;
  workspace_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export type ExecutionAuthorizationOutcome =
  | "allowed"
  | "soft_block"
  | "hard_block";

export type ExecutionAuthorizationReasonCode =
  | "allowed"
  | "no_active_contract"
  | "contract_paused"
  | "contract_expired"
  | "account_out_of_scope"
  | "product_out_of_scope"
  | "platform_out_of_scope"
  | "action_not_permitted"
  | "risk_above_ceiling"
  | "cadence_total_exceeded"
  | "cadence_per_day_exceeded"
  | "cadence_per_platform_exceeded"
  | "outside_execution_window"
  | "paused_by_failure"
  | "paused_by_risk_event"
  | "demo_mode_blocked";

export type ExecutionAuthorizationSuggestedAction =
  | "proceed"
  | "send_to_backlog"
  | "reschedule"
  | "pause_contract"
  | "request_new_approval";

export interface ExecutionAuthorizationRow {
  id: string;
  workspace_id: string;
  contract_id: string | null;
  action_type: string;
  account_id: string | null;
  product_id: string | null;
  platform: string | null;
  scheduled_item_id: string | null;
  weekly_plan_item_id: string | null;
  outcome: ExecutionAuthorizationOutcome;
  reason_code: ExecutionAuthorizationReasonCode;
  reason_detail: string | null;
  suggested_action: ExecutionAuthorizationSuggestedAction | null;
  should_backlog: boolean;
  should_pause: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ExecutionAuthorizationInsert {
  id?: string;
  workspace_id: string;
  contract_id?: string | null;
  action_type: string;
  account_id?: string | null;
  product_id?: string | null;
  platform?: string | null;
  scheduled_item_id?: string | null;
  weekly_plan_item_id?: string | null;
  outcome: ExecutionAuthorizationOutcome;
  reason_code: ExecutionAuthorizationReasonCode;
  reason_detail?: string | null;
  suggested_action?: ExecutionAuthorizationSuggestedAction | null;
  should_backlog?: boolean;
  should_pause?: boolean;
  metadata?: Record<string, unknown>;
}

// =====================================================================
// Phase E2 — Execution Engine
// =====================================================================

export type ExecutionQueueStatus =
  | "draft"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export type ExecutionItemStatus =
  | "pending_authorization"
  | "authorized"
  | "scheduled"
  | "ready"
  | "running"
  | "completed"
  | "blocked"
  | "backlogged"
  | "skipped"
  | "paused"
  | "failed"
  | "cancelled";

export type ExecutionItemRiskLevel =
  | "low"
  | "medium"
  | "high"
  | "blocked";

export type ExecutionLogSeverity = "debug" | "info" | "warning" | "error";

export type ExecutionAttemptStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked";

export interface ExecutionQueueRow {
  id: string;
  workspace_id: string;
  contract_id: string;
  created_by: string | null;
  title: string;
  status: ExecutionQueueStatus;
  week_start: string;
  week_end: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface ExecutionQueueInsert {
  id?: string;
  workspace_id: string;
  contract_id: string;
  created_by?: string | null;
  title: string;
  status?: ExecutionQueueStatus;
  week_start: string;
  week_end: string;
  metadata?: Record<string, unknown>;
}
export interface ExecutionQueueUpdate {
  title?: string;
  status?: ExecutionQueueStatus;
  week_start?: string;
  week_end?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionItemRow {
  id: string;
  workspace_id: string;
  queue_id: string;
  contract_id: string;
  source_entity_type: string | null;
  source_entity_id: string | null;
  product_id: string | null;
  account_id: string | null;
  platform: string | null;
  action_type: string;
  title: string | null;
  body: string | null;
  link_url: string | null;
  scheduled_at: string | null;
  status: ExecutionItemStatus;
  risk_score: number | null;
  risk_level: ExecutionItemRiskLevel | null;
  authorization_id: string | null;
  attempt_count: number;
  max_attempts: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface ExecutionItemInsert {
  id?: string;
  workspace_id: string;
  queue_id: string;
  contract_id: string;
  source_entity_type?: string | null;
  source_entity_id?: string | null;
  product_id?: string | null;
  account_id?: string | null;
  platform?: string | null;
  action_type: string;
  title?: string | null;
  body?: string | null;
  link_url?: string | null;
  scheduled_at?: string | null;
  status?: ExecutionItemStatus;
  risk_score?: number | null;
  risk_level?: ExecutionItemRiskLevel | null;
  authorization_id?: string | null;
  attempt_count?: number;
  max_attempts?: number;
  metadata?: Record<string, unknown>;
}
export interface ExecutionItemUpdate {
  status?: ExecutionItemStatus;
  scheduled_at?: string | null;
  risk_score?: number | null;
  risk_level?: ExecutionItemRiskLevel | null;
  authorization_id?: string | null;
  attempt_count?: number;
  max_attempts?: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionLogRow {
  id: string;
  workspace_id: string;
  queue_id: string | null;
  execution_item_id: string | null;
  event_type: string;
  severity: ExecutionLogSeverity;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface ExecutionLogInsert {
  id?: string;
  workspace_id: string;
  queue_id?: string | null;
  execution_item_id?: string | null;
  event_type: string;
  severity?: ExecutionLogSeverity;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionAttemptRow {
  id: string;
  workspace_id: string;
  execution_item_id: string;
  attempt_number: number;
  status: ExecutionAttemptStatus;
  started_at: string;
  finished_at: string | null;
  error_summary: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface ExecutionAttemptInsert {
  id?: string;
  workspace_id: string;
  execution_item_id: string;
  attempt_number: number;
  status: ExecutionAttemptStatus;
  started_at?: string;
  finished_at?: string | null;
  error_summary?: string | null;
  metadata?: Record<string, unknown>;
}
export interface ExecutionAttemptUpdate {
  status?: ExecutionAttemptStatus;
  finished_at?: string | null;
  error_summary?: string | null;
  metadata?: Record<string, unknown>;
}

// =====================================================================
// Phase E3 — Platform OAuth connections
// =====================================================================

export type OAuthPlatform = "reddit" | "x" | "linkedin";

export type PlatformConnectionConnectionStatus =
  | "not_connected"
  | "connected"
  | "expired"
  | "revoked"
  | "error"
  | "disabled"
  | "reauthorization_required";

export type PlatformConnectionHealthStatus =
  | "healthy"
  | "degraded"
  | "expired"
  | "revoked"
  | "unknown";

export interface PlatformConnectionRow {
  id: string;
  workspace_id: string;
  account_id: string | null;
  platform: OAuthPlatform;
  provider_account_id: string | null;
  handle: string | null;
  display_name: string | null;
  connection_status: PlatformConnectionConnectionStatus;
  scopes: string[];
  /**
   * Token columns are server-only. The repository layer projects these
   * away before returning to the client. Never log, never render.
   */
  access_token_encrypted: string | null;
  refresh_token_encrypted: string | null;
  expires_at: string | null;
  connected_at: string | null;
  revoked_at: string | null;
  last_checked_at: string | null;
  health_status: PlatformConnectionHealthStatus;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PlatformConnectionInsert {
  id?: string;
  workspace_id: string;
  account_id?: string | null;
  platform: OAuthPlatform;
  provider_account_id?: string | null;
  handle?: string | null;
  display_name?: string | null;
  connection_status?: PlatformConnectionConnectionStatus;
  scopes?: string[];
  access_token_encrypted?: string | null;
  refresh_token_encrypted?: string | null;
  expires_at?: string | null;
  connected_at?: string | null;
  revoked_at?: string | null;
  last_checked_at?: string | null;
  health_status?: PlatformConnectionHealthStatus;
  metadata?: Record<string, unknown>;
}

export interface PlatformConnectionUpdate {
  account_id?: string | null;
  provider_account_id?: string | null;
  handle?: string | null;
  display_name?: string | null;
  connection_status?: PlatformConnectionConnectionStatus;
  scopes?: string[];
  access_token_encrypted?: string | null;
  refresh_token_encrypted?: string | null;
  expires_at?: string | null;
  connected_at?: string | null;
  revoked_at?: string | null;
  last_checked_at?: string | null;
  health_status?: PlatformConnectionHealthStatus;
  metadata?: Record<string, unknown>;
}

export interface OAuthStateTokenRow {
  state: string;
  workspace_id: string;
  user_id: string;
  platform: OAuthPlatform;
  account_id: string | null;
  redirect_after: string | null;
  code_verifier: string | null;
  created_at: string;
  expires_at: string;
}

export interface OAuthStateTokenInsert {
  state: string;
  workspace_id: string;
  user_id: string;
  platform: OAuthPlatform;
  account_id?: string | null;
  redirect_after?: string | null;
  code_verifier?: string | null;
  expires_at?: string;
}

// =====================================================================
// Phase E2.7 — MCP connector probes
// =====================================================================

export type McpConnectorType =
  | "supabase_mcp"
  | "github_mcp"
  | "vercel_manual";

export type McpProbeMode =
  | "direct_mcp"
  | "operator_bridge"
  | "internal_db_probe";

export type McpProbeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "expired"
  | "rejected";

export type McpProbeHealth = "healthy" | "degraded" | "failed" | "unknown";

export interface McpConnectorProbeRow {
  id: string;
  workspace_id: string;
  connector_type: McpConnectorType;
  mode: McpProbeMode;
  status: McpProbeStatus;
  requested_by: string | null;
  completed_by: string | null;
  capability_results: Record<string, unknown>;
  health_status: McpProbeHealth | null;
  error_summary: string | null;
  evidence: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface McpConnectorProbeInsert {
  id?: string;
  workspace_id: string;
  connector_type: McpConnectorType;
  mode?: McpProbeMode;
  status?: McpProbeStatus;
  requested_by?: string | null;
  completed_by?: string | null;
  capability_results?: Record<string, unknown>;
  health_status?: McpProbeHealth | null;
  error_summary?: string | null;
  evidence?: Record<string, unknown>;
  expires_at?: string | null;
  completed_at?: string | null;
}

export interface McpConnectorProbeUpdate {
  status?: McpProbeStatus;
  completed_by?: string | null;
  capability_results?: Record<string, unknown>;
  health_status?: McpProbeHealth | null;
  error_summary?: string | null;
  evidence?: Record<string, unknown>;
  expires_at?: string | null;
  completed_at?: string | null;
}

// =====================================================================
// Phase E2.8 — Operator bridge runtime
// =====================================================================

export type BridgeAssistantType =
  | "claude_code"
  | "codex"
  | "claude_opus"
  | "supabase_mcp"
  | "github_mcp"
  | "vercel_manual";

export type BridgeRequestType =
  | "repo_check"
  | "db_check"
  | "rls_check"
  | "migration_review"
  | "pr_readiness_review"
  | "import_mapping"
  | "smoke_test"
  | "deployment_review"
  | "architecture_audit";

export type BridgeRiskLevel =
  | "safe_read"
  | "local_write"
  | "remote_write"
  | "production_impacting"
  | "blocked";

export type BridgeApprovalMode =
  | "no_approval_needed"
  | "approval_required"
  | "explicit_text_confirmation_required"
  | "blocked";

export type BridgeRequestStatus =
  | "draft"
  | "pending_operator"
  | "copied"
  | "running"
  | "result_submitted"
  | "verified"
  | "failed_verification"
  | "expired"
  | "cancelled"
  | "rejected"
  | "completed";

export type BridgeResultStatus = "submitted" | "verified" | "rejected" | "failed";

export type BridgeVerificationStatus =
  | "pending"
  | "verified"
  | "rejected"
  | "failed";

export type BridgeNonceStatus = "active" | "used" | "expired" | "revoked";

export interface OperatorBridgeRequestRow {
  id: string;
  workspace_id: string;
  operation_run_id: string | null;
  requested_by: string | null;
  assigned_to: string | null;
  assistant_type: BridgeAssistantType;
  request_type: BridgeRequestType;
  risk_level: BridgeRiskLevel;
  approval_mode: BridgeApprovalMode;
  status: BridgeRequestStatus;
  title: string;
  task_prompt: string;
  expected_result_schema: Record<string, unknown>;
  allowed_capabilities: string[];
  blocked_capabilities: string[];
  expires_at: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
export interface OperatorBridgeRequestInsert {
  id?: string;
  workspace_id: string;
  operation_run_id?: string | null;
  requested_by?: string | null;
  assigned_to?: string | null;
  assistant_type: BridgeAssistantType;
  request_type: BridgeRequestType;
  risk_level: BridgeRiskLevel;
  approval_mode: BridgeApprovalMode;
  status?: BridgeRequestStatus;
  title: string;
  task_prompt: string;
  expected_result_schema?: Record<string, unknown>;
  allowed_capabilities?: string[];
  blocked_capabilities?: string[];
  expires_at: string;
  metadata?: Record<string, unknown>;
}
export interface OperatorBridgeRequestUpdate {
  status?: BridgeRequestStatus;
  assigned_to?: string | null;
  metadata?: Record<string, unknown>;
  expires_at?: string;
  operation_run_id?: string | null;
}

export interface OperatorBridgeResultRow {
  id: string;
  workspace_id: string;
  request_id: string;
  submitted_by: string | null;
  assistant_type: BridgeAssistantType;
  status: BridgeResultStatus;
  result_summary: string;
  result_payload: Record<string, unknown>;
  verification_status: BridgeVerificationStatus;
  verification_errors: string[];
  signature: string | null;
  signed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
export interface OperatorBridgeResultInsert {
  id?: string;
  workspace_id: string;
  request_id: string;
  submitted_by?: string | null;
  assistant_type: BridgeAssistantType;
  status?: BridgeResultStatus;
  result_summary: string;
  result_payload?: Record<string, unknown>;
  verification_status?: BridgeVerificationStatus;
  verification_errors?: string[];
  signature?: string | null;
  signed_at?: string | null;
  metadata?: Record<string, unknown>;
}
export interface OperatorBridgeResultUpdate {
  status?: BridgeResultStatus;
  verification_status?: BridgeVerificationStatus;
  verification_errors?: string[];
  metadata?: Record<string, unknown>;
}

export interface OperatorBridgeNonceRow {
  id: string;
  workspace_id: string;
  request_id: string;
  nonce: string;
  status: BridgeNonceStatus;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}
export interface OperatorBridgeNonceInsert {
  id?: string;
  workspace_id: string;
  request_id: string;
  nonce: string;
  status?: BridgeNonceStatus;
  expires_at: string;
  used_at?: string | null;
}
export interface OperatorBridgeNonceUpdate {
  status?: BridgeNonceStatus;
  used_at?: string | null;
}

// =====================================================================
// Phase F0 — Signal MCP server
// =====================================================================

export type McpOperatorTokenStatus = "active" | "revoked" | "expired";

export interface McpOperatorTokenRow {
  id: string;
  workspace_id: string;
  created_by: string | null;
  name: string;
  token_hash: string;
  token_preview: string;
  status: McpOperatorTokenStatus;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface McpOperatorTokenInsert {
  id?: string;
  workspace_id: string;
  created_by?: string | null;
  name: string;
  token_hash: string;
  token_preview: string;
  status?: McpOperatorTokenStatus;
  scopes?: string[];
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
}
export interface McpOperatorTokenUpdate {
  name?: string;
  status?: McpOperatorTokenStatus;
  scopes?: string[];
  last_used_at?: string | null;
  expires_at?: string | null;
  revoked_at?: string | null;
}

export type McpToolCallStatus =
  | "allowed"
  | "completed"
  | "failed"
  | "blocked"
  | "unauthorized";

export type McpToolRiskLevel =
  | "safe_read"
  | "local_write"
  | "remote_write"
  | "production_impacting"
  | "blocked";

export type McpToolApprovalMode =
  | "no_approval_needed"
  | "approval_required"
  | "explicit_text_confirmation_required"
  | "blocked";

export interface McpToolCallRow {
  id: string;
  workspace_id: string;
  operator_token_id: string | null;
  tool_name: string;
  risk_level: McpToolRiskLevel;
  approval_mode: McpToolApprovalMode;
  status: McpToolCallStatus;
  input_summary: string | null;
  output_summary: string | null;
  error_summary: string | null;
  created_at: string;
}
export interface McpToolCallInsert {
  id?: string;
  workspace_id: string;
  operator_token_id?: string | null;
  tool_name: string;
  risk_level: McpToolRiskLevel;
  approval_mode: McpToolApprovalMode;
  status: McpToolCallStatus;
  input_summary?: string | null;
  output_summary?: string | null;
  error_summary?: string | null;
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
      weekly_plan_item_creatives: {
        Row: WeeklyPlanItemCreativeRow;
        Insert: WeeklyPlanItemCreativeInsert;
        Update: WeeklyPlanItemCreativeUpdate;
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
      mcp_operation_runs: {
        Row: McpOperationRunRow;
        Insert: McpOperationRunInsert;
        Update: McpOperationRunUpdate;
        Relationships: [];
      };
      weekly_approval_contracts: {
        Row: WeeklyApprovalContractRow;
        Insert: WeeklyApprovalContractInsert;
        Update: WeeklyApprovalContractUpdate;
        Relationships: [];
      };
      weekly_contract_accounts: {
        Row: WeeklyContractAccountRow;
        Insert: WeeklyContractAccountInsert;
        Update: Partial<WeeklyContractAccountInsert>;
        Relationships: [];
      };
      weekly_contract_products: {
        Row: WeeklyContractProductRow;
        Insert: WeeklyContractProductInsert;
        Update: Partial<WeeklyContractProductInsert>;
        Relationships: [];
      };
      weekly_contract_platforms: {
        Row: WeeklyContractPlatformRow;
        Insert: WeeklyContractPlatformInsert;
        Update: Partial<WeeklyContractPlatformInsert>;
        Relationships: [];
      };
      weekly_contract_allowed_actions: {
        Row: WeeklyContractAllowedActionRow;
        Insert: WeeklyContractAllowedActionInsert;
        Update: Partial<WeeklyContractAllowedActionInsert>;
        Relationships: [];
      };
      weekly_contract_execution_windows: {
        Row: WeeklyContractExecutionWindowRow;
        Insert: WeeklyContractExecutionWindowInsert;
        Update: Partial<WeeklyContractExecutionWindowInsert>;
        Relationships: [];
      };
      execution_authorizations: {
        Row: ExecutionAuthorizationRow;
        Insert: ExecutionAuthorizationInsert;
        Update: Partial<ExecutionAuthorizationInsert>;
        Relationships: [];
      };
      execution_queues: {
        Row: ExecutionQueueRow;
        Insert: ExecutionQueueInsert;
        Update: ExecutionQueueUpdate;
        Relationships: [];
      };
      execution_items: {
        Row: ExecutionItemRow;
        Insert: ExecutionItemInsert;
        Update: ExecutionItemUpdate;
        Relationships: [];
      };
      execution_logs: {
        Row: ExecutionLogRow;
        Insert: ExecutionLogInsert;
        Update: Partial<ExecutionLogInsert>;
        Relationships: [];
      };
      execution_attempts: {
        Row: ExecutionAttemptRow;
        Insert: ExecutionAttemptInsert;
        Update: ExecutionAttemptUpdate;
        Relationships: [];
      };
      platform_connections: {
        Row: PlatformConnectionRow;
        Insert: PlatformConnectionInsert;
        Update: PlatformConnectionUpdate;
        Relationships: [];
      };
      oauth_state_tokens: {
        Row: OAuthStateTokenRow;
        Insert: OAuthStateTokenInsert;
        Update: Partial<OAuthStateTokenInsert>;
        Relationships: [];
      };
      mcp_connector_probes: {
        Row: McpConnectorProbeRow;
        Insert: McpConnectorProbeInsert;
        Update: McpConnectorProbeUpdate;
        Relationships: [];
      };
      operator_bridge_requests: {
        Row: OperatorBridgeRequestRow;
        Insert: OperatorBridgeRequestInsert;
        Update: OperatorBridgeRequestUpdate;
        Relationships: [];
      };
      operator_bridge_results: {
        Row: OperatorBridgeResultRow;
        Insert: OperatorBridgeResultInsert;
        Update: OperatorBridgeResultUpdate;
        Relationships: [];
      };
      operator_bridge_nonces: {
        Row: OperatorBridgeNonceRow;
        Insert: OperatorBridgeNonceInsert;
        Update: OperatorBridgeNonceUpdate;
        Relationships: [];
      };
      mcp_operator_tokens: {
        Row: McpOperatorTokenRow;
        Insert: McpOperatorTokenInsert;
        Update: McpOperatorTokenUpdate;
        Relationships: [];
      };
      mcp_tool_calls: {
        Row: McpToolCallRow;
        Insert: McpToolCallInsert;
        Update: Partial<McpToolCallInsert>;
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
