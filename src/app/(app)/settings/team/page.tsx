import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import {
  getPrimaryWorkspace,
  isCallerWorkspaceOwner,
  listWorkspaceMembers,
} from "@/repositories/workspace-repository";
import { listAuthUserEmails } from "@/repositories/auth-user-lookup";
import { AddTeamMemberForm } from "./_add-form";
import { RemoveMemberButton } from "./_remove-button";

export const dynamic = "force-dynamic";

/**
 * /settings/team — Phase F10 Team Access Management.
 *
 * Lets a workspace owner:
 *   - see who has access to this workspace
 *   - add an existing Signal user by email (worker must self-signup
 *     at /signup first; no invite emails, no magic links)
 *   - remove a member's workspace access
 *
 * Out of scope for this PR: ownership transfer, role changes,
 * Supabase Auth user deletion, invite emails.
 */
export default async function TeamPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Team"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="rounded-2xl border border-ink-200 bg-white p-5 text-sm text-ink-600">
            Supabase is not configured. Set the Supabase environment variables
            before managing workspace members.
          </div>
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

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const callerUserId = user?.id ?? null;

  const isOwner = await isCallerWorkspaceOwner(membership.workspace.id);

  const members = await listWorkspaceMembers(membership.workspace.id);
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
        {/* ─────────────── Overview ─────────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            How Team Access works
          </h2>
          <p className="text-xs text-ink-600 mt-2 leading-relaxed">
            Ask the worker to create a Signal account with email and password
            first at{" "}
            <Link
              href="/signup"
              className="text-signal-700 underline font-mono"
            >
              /signup
            </Link>
            . Then add their email here to grant access to this workspace.
          </p>
          <p className="text-xs text-ink-500 mt-2 leading-relaxed">
            This does not delete Supabase Auth users. It only grants or removes
            access to this workspace. Removing a member leaves their Signal
            account intact and preserves all historical audit, publish history,
            and platform connections.
          </p>
        </section>

        {/* ─────────────── Add member ─────────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Add an existing Signal user
          </h2>
          <p className="text-xs text-ink-600 mt-1 leading-relaxed">
            New members are added as{" "}
            <span className="font-mono">editor</span> by default. Roles can be
            adjusted directly in the Supabase dashboard until role management
            ships in a follow-up.
          </p>
          {isOwner ? (
            <div className="mt-3">
              <AddTeamMemberForm />
            </div>
          ) : (
            <div className="mt-3 rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
              Only the workspace owner can add members.
            </div>
          )}
        </section>

        {/* ─────────────── Member list ─────────────── */}
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Workspace members
          </h2>
          <p className="text-xs text-ink-500 mt-1 leading-relaxed">
            {members.length} member{members.length === 1 ? "" : "s"} ·{" "}
            {ownerCount} owner{ownerCount === 1 ? "" : "s"}
          </p>
          <ul className="mt-3 divide-y divide-ink-100">
            {members.map((m) => {
              const email = emailsByUserId.get(m.userId) ?? null;
              const isCallerRow = m.userId === callerUserId;
              const disableRemoveReason = computeDisableRemoveReason({
                memberRole: m.role,
                memberUserId: m.userId,
                callerUserId,
                callerIsOnlyOwner,
                isOwner,
              });
              return (
                <li
                  key={m.userId}
                  className="py-3 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-ink-900 truncate">
                      <span className="font-mono">
                        {email ?? `user ${m.userId.slice(0, 8)}…`}
                      </span>
                      {isCallerRow ? (
                        <span className="ml-2 text-[10px] text-ink-500">
                          (you)
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-500">
                      <RoleBadge role={m.role} />
                      <span>
                        joined {formatDate(m.createdAt)}
                      </span>
                    </div>
                  </div>
                  {isOwner ? (
                    <RemoveMemberButton
                      userId={m.userId}
                      label={email ?? m.userId.slice(0, 8)}
                      disabledReason={disableRemoveReason}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        {/* ─────────────── Footer copy ─────────────── */}
        <section className="card p-5 text-[11px] text-ink-500 leading-relaxed">
          <p>
            This page only manages workspace access. It does not change a
            user&apos;s ability to sign in to Signal, and it does not modify
            any platform connections, publish history, or scheduled posts.
          </p>
          <p className="mt-2">
            Workspace ownership transfer, role changes, and email-based
            invites are intentionally not part of this PR — they ship in a
            follow-up.
          </p>
        </section>
      </div>
    </>
  );
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    owner: "badge-low",
    admin: "badge-low",
    editor: "badge-neutral",
    reviewer: "badge-neutral",
    viewer: "badge-neutral",
  };
  return <span className={`${map[role] ?? "badge-neutral"} text-[10px]`}>{role}</span>;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
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

/**
 * Returns a tooltip string when the remove button should be disabled
 * for this row, or undefined when the button is enabled. The server
 * action enforces these invariants too; this helper just keeps the
 * button surface honest.
 */
function computeDisableRemoveReason(
  input: DisableRemoveInput,
): string | undefined {
  if (!input.isOwner) {
    return "Only the workspace owner can remove members.";
  }
  if (input.callerIsOnlyOwner && input.memberUserId === input.callerUserId) {
    return "You are the only owner. Add another owner before removing yourself.";
  }
  if (input.memberRole === "owner") {
    return "Ownership transfer is not yet available — remove this owner from the Supabase dashboard.";
  }
  return undefined;
}
