import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import {
  getPrimaryWorkspace,
  getWorkspaceMemberActivity,
  listMyWorkspaces,
  listWorkspaceMembers,
} from "@/repositories/workspace-repository";
import { listAuthUserEmails } from "@/repositories/auth-user-lookup";
import { listInvitations } from "@/repositories/invitation-repository";
import { can, roleLabel } from "@/core/teams/permissions";
import type { WorkspaceRole } from "@/lib/supabase/types";
import { AddTeamMemberForm } from "./_add-form";
import { RemoveMemberButton } from "./_remove-button";
import { InviteForm } from "./_invite-form";
import { PendingInvites } from "./_pending-invites";
import {
  ChangeRoleControl,
  TransferOwnershipControl,
} from "./_member-controls";
import { WorkspaceSwitcher } from "./_workspace-switcher";

export const dynamic = "force-dynamic";

/**
 * /settings/team — Phase C1 Teams.
 *
 * Owner/admin: invite by email, manage roles (incl. reviewer), revoke
 * pending invites. Owner only: transfer ownership. Everyone: see member
 * activity (real audit data) + switch workspace. Owner invariant
 * (never zero owners) is enforced in the actions + repository.
 */
export default async function TeamPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Team" description="Persistence not configured." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Supabase is not configured.
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Team" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace from the dashboard first.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  const callerRole = membership.role;
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const callerUserId = user?.id ?? null;

  const canManage = can(callerRole, "manage_members");
  const canInvite = can(callerRole, "invite_members");
  const canTransfer = can(callerRole, "transfer_ownership");

  const [members, myWorkspaces, activity, invitations] = await Promise.all([
    listWorkspaceMembers(workspaceId),
    listMyWorkspaces(),
    getWorkspaceMemberActivity(workspaceId),
    canInvite
      ? listInvitations(workspaceId, { statuses: ["pending"] })
      : Promise.resolve([]),
  ]);
  const emailsByUserId = await listAuthUserEmails(members.map((m) => m.userId));
  const ownerCount = members.filter((m) => m.role === "owner").length;
  const callerIsOnlyOwner =
    ownerCount === 1 &&
    callerUserId !== null &&
    members.some((m) => m.userId === callerUserId && m.role === "owner");

  return (
    <>
      <Topbar
        title="Team"
        description={`Members of ${membership.workspace.name}.`}
        actions={
          <Link href="/settings" className="btn-ghost text-xs">
            ← Back to settings
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {/* Workspace switcher */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Your workspaces</h2>
          <p className="text-xs text-ink-500 mt-1 mb-2">
            Switching changes the active workspace everywhere.
          </p>
          <WorkspaceSwitcher
            workspaces={myWorkspaces.map((w) => ({
              id: w.workspaceId,
              name: w.workspace.name,
              role: roleLabel(w.role),
              isActive: w.workspaceId === workspaceId,
            }))}
          />
        </section>

        {/* Invite by email */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Invite a teammate</h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            Invite by email — they don&apos;t need a Signal account yet. The
            invitation completes when they sign up and open the link.
          </p>
          {canInvite ? (
            <div className="mt-3">
              <InviteForm />
            </div>
          ) : (
            <div className="mt-3 rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
              Only owners and admins can invite members.
            </div>
          )}
          {canInvite ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold text-ink-700">Pending invitations</h3>
              <PendingInvites
                invites={invitations.map((i) => ({
                  id: i.id,
                  email: i.email,
                  role: i.role,
                  expiresAt: i.expiresAt,
                }))}
              />
            </div>
          ) : null}
        </section>

        {/* Add an existing user (kept) */}
        {canManage ? (
          <section className="card p-5">
            <h2 className="text-sm font-semibold text-ink-900">
              Add an existing Signal user
            </h2>
            <p className="text-xs text-ink-600 mt-1 leading-relaxed">
              If the person already has an account, add them directly (joins as
              editor).
            </p>
            <div className="mt-3">
              <AddTeamMemberForm />
            </div>
          </section>
        ) : null}

        {/* Member list + role controls + activity */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Workspace members</h2>
          <p className="text-xs text-ink-500 mt-1">
            {members.length} member{members.length === 1 ? "" : "s"} · {ownerCount}{" "}
            owner{ownerCount === 1 ? "" : "s"}
          </p>
          <ul className="mt-3 divide-y divide-ink-100">
            {members.map((m) => {
              const email = emailsByUserId.get(m.userId) ?? null;
              const isCallerRow = m.userId === callerUserId;
              const act = activity.get(m.userId);
              const disableRemoveReason = computeDisableRemoveReason({
                memberRole: m.role,
                memberUserId: m.userId,
                callerUserId,
                callerIsOnlyOwner,
                isOwner: canManage,
              });
              return (
                <li key={m.userId} className="py-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-ink-900 truncate">
                        <span className="font-mono">
                          {email ?? `user ${m.userId.slice(0, 8)}…`}
                        </span>
                        {isCallerRow ? (
                          <span className="ml-2 text-[10px] text-ink-500">(you)</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
                        <RoleBadge role={m.role} />
                        <span>joined {formatDate(m.createdAt)}</span>
                        {act?.lastActivityAt ? (
                          <span>· last active {formatDate(act.lastActivityAt)}</span>
                        ) : null}
                        {act ? (
                          <span>
                            · {act.approvalCount} approval
                            {act.approvalCount === 1 ? "" : "s"} · {act.publishCount}{" "}
                            publish{act.publishCount === 1 ? "" : "es"}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {canManage ? (
                      <RemoveMemberButton
                        userId={m.userId}
                        label={email ?? m.userId.slice(0, 8)}
                        disabledReason={disableRemoveReason}
                      />
                    ) : null}
                  </div>
                  {/* Role controls (owner/admin) — never on the last owner */}
                  {canManage && m.role !== "owner" ? (
                    <div className="flex flex-wrap items-center gap-3 pl-0.5">
                      <ChangeRoleControl userId={m.userId} currentRole={m.role} />
                      {canTransfer && !isCallerRow ? (
                        <TransferOwnershipControl
                          userId={m.userId}
                          label={email ?? m.userId.slice(0, 8)}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card p-5 text-[11px] text-ink-500 leading-relaxed">
          <p>
            This page manages workspace access + roles only. It never deletes
            Signal accounts, platform connections, publish history, or scheduled
            posts. The workspace always keeps at least one owner.
          </p>
        </section>
      </div>
    </>
  );
}

function RoleBadge({ role }: { role: WorkspaceRole }) {
  const map: Record<string, string> = {
    owner: "badge-low",
    admin: "badge-low",
    editor: "badge-neutral",
    reviewer: "badge-info",
    viewer: "badge-neutral",
  };
  return <span className={`${map[role] ?? "badge-neutral"} text-[10px]`}>{roleLabel(role)}</span>;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

interface DisableRemoveInput {
  memberRole: string;
  memberUserId: string;
  callerUserId: string | null;
  callerIsOnlyOwner: boolean;
  isOwner: boolean;
}

function computeDisableRemoveReason(
  input: DisableRemoveInput,
): string | undefined {
  if (!input.isOwner) {
    return "Only owners and admins can remove members.";
  }
  if (input.callerIsOnlyOwner && input.memberUserId === input.callerUserId) {
    return "You are the only owner. Transfer ownership before removing yourself.";
  }
  if (input.memberRole === "owner") {
    return "Transfer ownership before removing an owner.";
  }
  return undefined;
}
