"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  addWorkspaceMember,
  countWorkspaceOwners,
  isCallerWorkspaceOwner,
  isWorkspaceMember,
  listWorkspaceMembers,
  removeWorkspaceMember,
} from "@/repositories/workspace-repository";
import { findAuthUserIdByEmail } from "@/repositories/auth-user-lookup";
import type { WorkspaceRole } from "@/lib/supabase/types";

/**
 * Phase F10 — Team Access Management server actions.
 *
 * Scope:
 *   - Add an EXISTING Signal user to the caller's primary workspace
 *     by email. No invite emails, no magic links, no Supabase Auth
 *     user creation. The worker must self-signup at /signup first.
 *   - Remove a non-owner member from the caller's primary workspace.
 *     Never deletes auth.users, never deletes the workspace itself,
 *     never deletes publish_history / execution_items / platform_
 *     connections / activity rows. The `_by` audit columns on those
 *     tables are SET NULL on auth.users delete — we don't trigger
 *     that path either; we only touch workspace_members.
 *
 * Permission model:
 *   - Only the workspace owner can add/remove members. The cookie-
 *     aware client + existing RLS policies enforce this at the DB
 *     layer as a defense-in-depth backstop, but the action also
 *     short-circuits with `permission_denied` so the UI shows a
 *     clean message.
 *   - `findAuthUserIdByEmail` is the ONLY place that uses the
 *     service-role client (auth.users is in the `auth` schema). It
 *     reads `{ id, email }` only — never password hashes, never
 *     metadata.
 *
 * Owner invariants:
 *   - Workspace must never end with zero owners. The remove flow
 *     blocks the deletion when it would leave the workspace empty
 *     of owner-role members.
 *   - This PR does NOT implement ownership transfer or multi-owner
 *     reconciliation. The smallest safe operation is "remove a non-
 *     owner member"; removing owners requires an explicit successor
 *     and is out of scope for v1.
 */

export type AddMemberOutcome =
  | { kind: "ok"; addedUserId: string; addedEmail: string }
  | { kind: "missing_email" }
  | { kind: "no_workspace" }
  | { kind: "permission_denied" }
  | { kind: "must_sign_up"; email: string }
  | { kind: "already_member"; email: string }
  | { kind: "error"; message: string };

export type RemoveMemberOutcome =
  | { kind: "ok"; removedUserId: string }
  | { kind: "missing_user_id" }
  | { kind: "no_workspace" }
  | { kind: "permission_denied" }
  | { kind: "cannot_remove_last_owner" }
  | { kind: "cannot_remove_self_last_owner" }
  | { kind: "not_a_member" }
  | { kind: "error"; message: string };

const DEFAULT_NEW_MEMBER_ROLE: WorkspaceRole = "editor";

interface ActionContext {
  workspaceId: string;
  callerUserId: string;
}

/**
 * Resolve the caller's primary workspace + verify they're an owner.
 * Returns null when no workspace, permission denied, or any
 * unrecoverable error — caller maps to the appropriate outcome.
 */
async function requireOwnerContext(): Promise<
  | { ctx: ActionContext; kind: "ok" }
  | { kind: "no_workspace" }
  | { kind: "permission_denied" }
> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "permission_denied" };
  const membership = await getPrimaryWorkspace();
  if (!membership) return { kind: "no_workspace" };
  const isOwner = await isCallerWorkspaceOwner(membership.workspace.id);
  if (!isOwner) return { kind: "permission_denied" };
  return {
    kind: "ok",
    ctx: { workspaceId: membership.workspace.id, callerUserId: user.id },
  };
}

/**
 * Add an existing Signal user to the caller's primary workspace by
 * email. Default role: `editor` (publish + edit; not owner). Caller
 * must be an owner of the workspace.
 */
export async function addMemberAction(
  _prevState: AddMemberOutcome | null,
  formData: FormData,
): Promise<AddMemberOutcome> {
  const rawEmail = String(formData.get("email") ?? "").trim();
  if (rawEmail.length === 0) return { kind: "missing_email" };

  const guard = await requireOwnerContext();
  if (guard.kind !== "ok") return { kind: guard.kind } as AddMemberOutcome;
  const { ctx } = guard;

  try {
    const lookup = await findAuthUserIdByEmail(rawEmail);
    if (!lookup) {
      return { kind: "must_sign_up", email: rawEmail };
    }
    const alreadyMember = await isWorkspaceMember({
      workspaceId: ctx.workspaceId,
      userId: lookup.id,
    });
    if (alreadyMember) {
      return { kind: "already_member", email: lookup.email ?? rawEmail };
    }
    await addWorkspaceMember({
      workspaceId: ctx.workspaceId,
      userId: lookup.id,
      role: DEFAULT_NEW_MEMBER_ROLE,
    });
    revalidatePath("/settings/team");
    return {
      kind: "ok",
      addedUserId: lookup.id,
      addedEmail: lookup.email ?? rawEmail,
    };
  } catch (err) {
    console.error("[settings/team] addMemberAction failed", err);
    return {
      kind: "error",
      message:
        err instanceof Error && err.message.length > 0
          ? err.message
          : "Could not add this user to the workspace.",
    };
  }
}

/**
 * Remove a workspace_members row by `user_id`. Caller must be an
 * owner of the workspace. Refuses to remove the last owner.
 */
export async function removeMemberAction(
  _prevState: RemoveMemberOutcome | null,
  formData: FormData,
): Promise<RemoveMemberOutcome> {
  const targetUserId = String(formData.get("user_id") ?? "").trim();
  if (targetUserId.length === 0) return { kind: "missing_user_id" };

  const guard = await requireOwnerContext();
  if (guard.kind !== "ok") return { kind: guard.kind } as RemoveMemberOutcome;
  const { ctx } = guard;

  try {
    const members = await listWorkspaceMembers(ctx.workspaceId);
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) return { kind: "not_a_member" };

    if (target.role === "owner") {
      const ownerCount = await countWorkspaceOwners(ctx.workspaceId);
      if (ownerCount <= 1) {
        if (target.userId === ctx.callerUserId) {
          return { kind: "cannot_remove_self_last_owner" };
        }
        return { kind: "cannot_remove_last_owner" };
      }
    }

    await removeWorkspaceMember({
      workspaceId: ctx.workspaceId,
      userId: targetUserId,
    });
    revalidatePath("/settings/team");
    return { kind: "ok", removedUserId: targetUserId };
  } catch (err) {
    console.error("[settings/team] removeMemberAction failed", err);
    return {
      kind: "error",
      message:
        err instanceof Error && err.message.length > 0
          ? err.message
          : "Could not remove this member from the workspace.",
    };
  }
}
