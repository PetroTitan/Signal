"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  changeMemberRoleAction,
  transferOwnershipAction,
} from "./_actions";
import { roleLabel } from "@/core/teams/permissions";
import type { ActionResult } from "@/lib/forms/action-result";
import type { WorkspaceRole } from "@/lib/supabase/types";

const initial: ActionResult = { ok: false, error: "" };
const ROLES: WorkspaceRole[] = ["admin", "editor", "reviewer", "viewer"];

function SaveRole() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn text-[11px] disabled:opacity-50">
      {pending ? "…" : "Set role"}
    </button>
  );
}

/** Owner/admin: change a non-owner member's role. */
export function ChangeRoleControl({
  userId,
  currentRole,
}: {
  userId: string;
  currentRole: WorkspaceRole;
}) {
  const [state, action] = useFormState(changeMemberRoleAction, initial);
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="user_id" value={userId} />
      <select name="role" defaultValue={currentRole} className="input text-[11px] py-0.5">
        {ROLES.map((r) => (
          <option key={r} value={r}>{roleLabel(r)}</option>
        ))}
      </select>
      <SaveRole />
      {state.error ? <span className="text-[10px] text-red-700">{state.error}</span> : null}
      {state.ok ? <span className="text-[10px] text-emerald-700">Saved ✓</span> : null}
    </form>
  );
}

function TransferSubmit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn text-[11px] disabled:opacity-50">
      {pending ? "Transferring…" : "Make owner"}
    </button>
  );
}

/** Owner only: transfer ownership to this member (typed confirmation). */
export function TransferOwnershipControl({
  userId,
  label,
}: {
  userId: string;
  label: string;
}) {
  const [state, action] = useFormState(transferOwnershipAction, initial);
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="user_id" value={userId} />
      <input
        name="confirm"
        placeholder='type "TRANSFER"'
        className="input text-[11px] py-0.5 w-28"
        aria-label={`Confirm transfer to ${label}`}
      />
      <TransferSubmit />
      {state.error ? <span className="text-[10px] text-red-700">{state.error}</span> : null}
      {state.ok ? <span className="text-[10px] text-emerald-700">Transferred ✓</span> : null}
    </form>
  );
}
