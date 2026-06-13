/**
 * Phase C1.2 — explicit role → permission matrix.
 *
 * The single source of truth for "what can this role do?". Server
 * actions and UI both gate on `can(role, permission)` so they cannot
 * drift. Pure module — no I/O.
 *
 * Roles (from workspace_members.role): owner > admin > editor >
 * reviewer > viewer.
 *
 *   - owner    : everything, including ownership transfer + billing.
 *   - admin    : manage members/settings/platforms + all content; NOT
 *                ownership transfer, NOT billing.
 *   - editor   : author + edit + approve content/creatives.
 *   - reviewer : review + approve content/creatives; cannot author,
 *                manage members/settings/platforms/billing, or transfer.
 *   - viewer   : read-only.
 *
 * Approval is NOT bypassed by anything here — reviewer/editor/admin/
 * owner all approve through the same approval flow; lower roles simply
 * lack the `approve_*` permission.
 */

import type { WorkspaceRole } from "@/lib/supabase/types";

export type Permission =
  | "view_content"
  | "review_content"
  | "approve_content"
  | "approve_creative"
  | "edit_content"
  | "manage_members"
  | "manage_settings"
  | "connect_platforms"
  | "manage_billing"
  | "invite_members"
  | "transfer_ownership";

export const ALL_PERMISSIONS: readonly Permission[] = [
  "view_content",
  "review_content",
  "approve_content",
  "approve_creative",
  "edit_content",
  "manage_members",
  "manage_settings",
  "connect_platforms",
  "manage_billing",
  "invite_members",
  "transfer_ownership",
] as const;

const REVIEWER: Permission[] = [
  "view_content",
  "review_content",
  "approve_content",
  "approve_creative",
];

const EDITOR: Permission[] = [...REVIEWER, "edit_content"];

const ADMIN: Permission[] = [
  ...EDITOR,
  "manage_members",
  "manage_settings",
  "connect_platforms",
  "invite_members",
];

const OWNER: Permission[] = [...ADMIN, "manage_billing", "transfer_ownership"];

export const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<Permission>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  editor: new Set(EDITOR),
  reviewer: new Set(REVIEWER),
  viewer: new Set(["view_content"] as Permission[]),
};

export function can(
  role: WorkspaceRole | null | undefined,
  permission: Permission,
): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/** Convenience: does this role have ANY of the given permissions? */
export function canAny(
  role: WorkspaceRole | null | undefined,
  permissions: Permission[],
): boolean {
  return permissions.some((p) => can(role, p));
}

/** Operator-facing label for a role (UI). */
export function roleLabel(role: WorkspaceRole): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "admin":
      return "Admin";
    case "editor":
      return "Editor";
    case "reviewer":
      return "Reviewer";
    case "viewer":
      return "Viewer";
  }
}

/** Roles a manager may assign via invite (never owner — that's a transfer). */
export const ASSIGNABLE_INVITE_ROLES: WorkspaceRole[] = [
  "admin",
  "editor",
  "reviewer",
  "viewer",
];
