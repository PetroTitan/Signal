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
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
  };
}
