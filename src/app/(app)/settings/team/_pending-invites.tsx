"use client";

import { useFormState, useFormStatus } from "react-dom";
import { revokeInvitationAction } from "./_actions";
import { roleLabel } from "@/core/teams/permissions";
import type { ActionResult } from "@/lib/forms/action-result";
import type { WorkspaceRole } from "@/lib/supabase/types";

const initial: ActionResult = { ok: false, error: "" };

export interface PendingInvite {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
}

function RevokeButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn text-[11px] disabled:opacity-50">
      {pending ? "…" : "Revoke"}
    </button>
  );
}

function Row({ invite }: { invite: PendingInvite }) {
  const [state, action] = useFormState(revokeInvitationAction, initial);
  if (state.ok) return null; // revoked → disappears
  return (
    <li className="py-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <span className="font-mono text-sm text-ink-800 truncate">{invite.email}</span>
        <span className="ml-2 text-[11px] text-ink-500">
          {roleLabel(invite.role)} · expires {new Date(invite.expiresAt).toLocaleDateString()}
        </span>
      </div>
      <form action={action}>
        <input type="hidden" name="invitation_id" value={invite.id} />
        <RevokeButton />
      </form>
    </li>
  );
}

export function PendingInvites({ invites }: { invites: PendingInvite[] }) {
  if (invites.length === 0) {
    return <p className="text-xs text-ink-500 mt-2">No pending invitations.</p>;
  }
  return (
    <ul className="mt-2 divide-y divide-ink-100">
      {invites.map((i) => (
        <Row key={i.id} invite={i} />
      ))}
    </ul>
  );
}
