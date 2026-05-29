"use client";

import { useFormState, useFormStatus } from "react-dom";
import { removeMemberAction, type RemoveMemberOutcome } from "./_actions";

interface RemoveMemberButtonProps {
  userId: string;
  /** Display label for confirm copy ("Remove worker@example.com?"). */
  label: string;
  /** Disables the button when the row is the caller's only-owner self. */
  disabledReason?: string;
}

const initial: RemoveMemberOutcome | null = null;

export function RemoveMemberButton(props: RemoveMemberButtonProps) {
  const [state, formAction] = useFormState(removeMemberAction, initial);

  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="user_id" value={props.userId} />
      <SubmitButton disabledReason={props.disabledReason} label={props.label} />
      {state ? <Outcome state={state} /> : null}
    </form>
  );
}

function SubmitButton({
  disabledReason,
  label,
}: {
  disabledReason?: string;
  label: string;
}) {
  const { pending } = useFormStatus();
  const disabled = pending || !!disabledReason;
  return (
    <button
      type="submit"
      disabled={disabled}
      title={disabledReason ?? `Remove ${label}`}
      onClick={(e) => {
        if (
          !window.confirm(
            `Remove ${label}? They will lose access to this workspace. Their Signal account remains intact.`,
          )
        ) {
          e.preventDefault();
        }
      }}
      className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
        disabled
          ? "border-ink-200 text-ink-400 bg-ink-50 cursor-not-allowed"
          : "border-ink-200 text-ink-700 bg-white hover:bg-ink-50 hover:text-red-700 hover:border-red-200"
      }`}
    >
      {pending ? "Removing…" : "Remove"}
    </button>
  );
}

function Outcome({ state }: { state: RemoveMemberOutcome }) {
  if (state.kind === "ok") return null; // page revalidates, list updates
  let copy: string;
  switch (state.kind) {
    case "missing_user_id":
      copy = "Could not determine which member to remove.";
      break;
    case "permission_denied":
      copy = "Only the workspace owner can remove members.";
      break;
    case "no_workspace":
      copy = "No workspace found.";
      break;
    case "not_a_member":
      copy = "This user is not a member of this workspace.";
      break;
    case "cannot_remove_last_owner":
      copy = "Cannot remove the last owner of the workspace.";
      break;
    case "cannot_remove_self_last_owner":
      copy =
        "You are the only owner. Add another owner before removing yourself.";
      break;
    case "error":
    default:
      copy = state.kind === "error" ? state.message : "Something went wrong.";
  }
  return (
    <span
      role="alert"
      className="text-[10px] text-amber-700 max-w-[14rem] text-right leading-tight"
    >
      {copy}
    </span>
  );
}
