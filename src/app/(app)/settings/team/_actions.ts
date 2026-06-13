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
import {
  countWorkspaceOwners as _countOwners,
  getWorkspaceById,
  listWorkspaceMembers as _listMembers,
  setPrimaryWorkspace,
  transferOwnership as transferOwnershipRepo,
  updateMemberRole,
} from "@/repositories/workspace-repository";
import { acceptInvitationByToken } from "@/repositories/invitation-repository";
import { hashInviteToken } from "@/core/teams/invite-token";
import { findAuthUserIdByEmail } from "@/repositories/auth-user-lookup";
import {
  createInvitation,
  findPendingInvitation,
  revokeInvitation,
} from "@/repositories/invitation-repository";
import { createNotification } from "@/repositories/notification-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { can, ASSIGNABLE_INVITE_ROLES } from "@/core/teams/permissions";
import {
  generateInviteToken,
  inviteExpiry,
  isValidEmail,
  normalizeInviteEmail,
} from "@/core/teams/invite-token";
import { actionFail, actionOk, type ActionResult } from "@/lib/forms/action-result";
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

// =====================================================================
// Phase C1 — invitations, role changes, ownership transfer
// =====================================================================

/** Resolve caller + role from the primary workspace (no owner gate). */
async function requireMemberContext(): Promise<
  | { kind: "ok"; workspaceId: string; callerUserId: string; role: WorkspaceRole }
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
  return {
    kind: "ok",
    workspaceId: membership.workspace.id,
    callerUserId: user.id,
    role: membership.role,
  };
}

export type InviteResult = ActionResult<{
  /** Relative accept path incl. token (UI prepends origin to copy). */
  acceptPath: string;
  email: string;
  alreadyHasAccount: boolean;
}>;

/**
 * C1.1 — invite a user by email (owner/admin). Generates a token,
 * stores only its hash, and returns the accept link to share (no email
 * provider is wired yet — see C2 for the sender abstraction). If the
 * email already has an account, also raises an in-app
 * `invitation_received` notification for them. Audited.
 */
export async function inviteMemberAction(
  _prev: InviteResult,
  formData: FormData,
): Promise<InviteResult> {
  const email = normalizeInviteEmail(String(formData.get("email") ?? ""));
  const roleRaw = String(formData.get("role") ?? "editor");
  const role = (ASSIGNABLE_INVITE_ROLES as string[]).includes(roleRaw)
    ? (roleRaw as WorkspaceRole)
    : "editor";
  if (!isValidEmail(email)) return actionFail("Enter a valid email address.");

  const ctx = await requireMemberContext();
  if (ctx.kind !== "ok") {
    return actionFail(
      ctx.kind === "no_workspace" ? "No workspace found." : "Not authorized.",
    );
  }
  if (!can(ctx.role, "invite_members")) {
    return actionFail("Only owners and admins can invite members.");
  }

  try {
    // Already a member?
    const existingUser = await findAuthUserIdByEmail(email);
    if (existingUser) {
      const already = await isWorkspaceMember({
        workspaceId: ctx.workspaceId,
        userId: existingUser.id,
      });
      if (already) return actionFail("That person is already a member.");
    }
    // One active pending invite per (workspace, email).
    const pending = await findPendingInvitation(ctx.workspaceId, email);
    if (pending) return actionFail("There's already a pending invite for that email.");

    const { token, tokenHash } = generateInviteToken();
    const invitation = await createInvitation({
      workspaceId: ctx.workspaceId,
      email,
      role,
      tokenHash,
      expiresAt: inviteExpiry(new Date()),
      invitedBy: ctx.callerUserId,
    });

    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "workspace.invitation_created",
      entityType: "workspace_invitation",
      entityId: invitation.id,
      title: `Invited ${email} as ${role}`,
      description: "Invitation created (pending acceptance).",
    }).catch(() => {});

    if (existingUser) {
      const workspace = await getWorkspaceById(ctx.workspaceId).catch(() => null);
      await createNotification({
        workspaceId: ctx.workspaceId,
        userId: existingUser.id,
        type: "invitation_received",
        title: `You've been invited to ${workspace?.name ?? "a workspace"}`,
        body: `Role: ${role}. Open the invite link to join.`,
        entityType: "workspace_invitation",
        entityId: invitation.id,
        dedupeKey: `invitation_received:${invitation.id}`,
      }).catch(() => {});
    }

    revalidatePath("/settings/team");
    return actionOk({
      acceptPath: `/invite/accept?token=${encodeURIComponent(token)}`,
      email,
      alreadyHasAccount: existingUser !== null,
    });
  } catch (err) {
    console.error("[settings/team] inviteMemberAction failed", err);
    return actionFail(
      err instanceof Error ? err.message : "Could not create the invitation.",
    );
  }
}

export async function revokeInvitationAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const invitationId = String(formData.get("invitation_id") ?? "").trim();
  if (!invitationId) return actionFail("Missing invitation id.");
  const ctx = await requireMemberContext();
  if (ctx.kind !== "ok" || !can(ctx.role, "invite_members")) {
    return actionFail("Not authorized.");
  }
  try {
    await revokeInvitation({ workspaceId: ctx.workspaceId, invitationId });
    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "workspace.invitation_revoked",
      entityType: "workspace_invitation",
      entityId: invitationId,
      title: "Invitation revoked",
    }).catch(() => {});
    revalidatePath("/settings/team");
    return actionOk();
  } catch (err) {
    console.error("[settings/team] revokeInvitationAction failed", err);
    return actionFail("Could not revoke the invitation.");
  }
}

export async function changeMemberRoleAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const userId = String(formData.get("user_id") ?? "").trim();
  const roleRaw = String(formData.get("role") ?? "").trim();
  if (!userId || !roleRaw) return actionFail("Missing user or role.");
  if (!(["admin", "editor", "reviewer", "viewer"] as string[]).includes(roleRaw)) {
    return actionFail("Pick a valid role (owner is set via transfer).");
  }
  const role = roleRaw as WorkspaceRole;

  const ctx = await requireMemberContext();
  if (ctx.kind !== "ok" || !can(ctx.role, "manage_members")) {
    return actionFail("Only owners and admins can change roles.");
  }
  try {
    const members = await _listMembers(ctx.workspaceId);
    const target = members.find((m) => m.userId === userId);
    if (!target) return actionFail("Not a member of this workspace.");
    // Never demote the last owner to a non-owner role.
    if (target.role === "owner") {
      const owners = await _countOwners(ctx.workspaceId);
      if (owners <= 1) {
        return actionFail(
          "Can't change the last owner's role. Transfer ownership first.",
        );
      }
    }
    await updateMemberRole({ workspaceId: ctx.workspaceId, userId, role });
    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "workspace.member_role_changed",
      entityType: "workspace_member",
      entityId: userId,
      title: `Member role changed to ${role}`,
    }).catch(() => {});
    revalidatePath("/settings/team");
    return actionOk();
  } catch (err) {
    console.error("[settings/team] changeMemberRoleAction failed", err);
    return actionFail("Could not change the member role.");
  }
}

export async function transferOwnershipAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const targetUserId = String(formData.get("user_id") ?? "").trim();
  const confirm = String(formData.get("confirm") ?? "").trim();
  if (!targetUserId) return actionFail("Pick a member to transfer ownership to.");
  if (confirm !== "TRANSFER") {
    return actionFail('Type "TRANSFER" to confirm.');
  }

  const ctx = await requireMemberContext();
  if (ctx.kind !== "ok" || !can(ctx.role, "transfer_ownership")) {
    return actionFail("Only the owner can transfer ownership.");
  }
  if (targetUserId === ctx.callerUserId) {
    return actionFail("You already own this workspace.");
  }
  try {
    const members = await _listMembers(ctx.workspaceId);
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) return actionFail("The new owner must already be a member.");

    await transferOwnershipRepo({
      workspaceId: ctx.workspaceId,
      fromUserId: ctx.callerUserId,
      toUserId: targetUserId,
    });
    await recordActivity({
      workspaceId: ctx.workspaceId,
      eventType: "workspace.ownership_transferred",
      entityType: "workspace",
      entityId: ctx.workspaceId,
      title: "Workspace ownership transferred",
      description: "The previous owner is now an admin.",
    }).catch(() => {});
    await createNotification({
      workspaceId: ctx.workspaceId,
      userId: targetUserId,
      type: "ownership_transferred",
      title: "You're now the workspace owner",
      body: "Ownership of this workspace was transferred to you.",
      entityType: "workspace",
      entityId: ctx.workspaceId,
      dedupeKey: `ownership_transferred:${ctx.workspaceId}:${targetUserId}`,
    }).catch(() => {});
    revalidatePath("/settings/team");
    return actionOk();
  } catch (err) {
    console.error("[settings/team] transferOwnershipAction failed", err);
    return actionFail("Could not transfer ownership.");
  }
}

/**
 * C1.5 — switch the active workspace. Reuses the existing primary-
 * workspace mechanism (`is_primary`), which the whole app already
 * follows via getPrimaryWorkspace — so RLS + primary behavior are
 * preserved and no new persistence is introduced.
 */
export async function switchWorkspaceAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const workspaceId = String(formData.get("workspace_id") ?? "").trim();
  if (!workspaceId) return actionFail("Missing workspace id.");
  try {
    await setPrimaryWorkspace({ workspaceId });
    // The active workspace drives almost every page — revalidate broadly.
    revalidatePath("/", "layout");
    return actionOk();
  } catch (err) {
    console.error("[settings/team] switchWorkspaceAction failed", err);
    return actionFail("Could not switch workspace.");
  }
}

/**
 * C1.1 — accept an invitation. The signed-in user presents the
 * plaintext token; we hash it and call the SECURITY DEFINER RPC, which
 * verifies status/expiry/email server-side and joins the workspace.
 * On success, switches to the joined workspace + notifies the inviter.
 */
export async function acceptInvitationAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return actionFail("Missing invitation token.");
  try {
    const result = await acceptInvitationByToken(hashInviteToken(token));
    if (!result.ok) return actionFail(result.detail);

    // Make the joined workspace active.
    await setPrimaryWorkspace({ workspaceId: result.workspaceId }).catch(() => {});
    await recordActivity({
      workspaceId: result.workspaceId,
      eventType: "workspace.invitation_accepted",
      entityType: "workspace",
      entityId: result.workspaceId,
      title: "Invitation accepted",
      description: "A member joined via invitation.",
    }).catch(() => {});

    revalidatePath("/", "layout");
    return actionOk();
  } catch (err) {
    console.error("[settings/team] acceptInvitationAction failed", err);
    return actionFail("Could not accept the invitation.");
  }
}
