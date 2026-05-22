"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  archiveBacklogItemAction,
  restoreBacklogItemAction,
  type BacklogActionState,
} from "./_actions";

const initial: BacklogActionState = { ok: false, error: null };

interface BacklogRowProps {
  backlogId: string;
  title: string | null;
  body: string | null;
  platform: string | null;
  reason: string | null;
  createdAt: string;
}

export function BacklogRow({
  backlogId,
  title,
  body,
  platform,
  reason,
  createdAt,
}: BacklogRowProps) {
  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink-900">
            {title ?? "Untitled"}
          </div>
          <div className="text-xs text-ink-500 mt-0.5">
            {platform ?? "—"} · added {new Date(createdAt).toLocaleString()}
          </div>
          {body ? (
            <p className="text-xs text-ink-700 mt-1 line-clamp-2">{body}</p>
          ) : null}
          {reason ? (
            <p className="text-[11px] text-ink-500 mt-1 italic">
              Reason: {reason}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <RestoreForm backlogId={backlogId} />
          <ArchiveForm backlogId={backlogId} />
        </div>
      </div>
    </li>
  );
}

function RestoreForm({ backlogId }: { backlogId: string }) {
  const [, action] = useFormState(restoreBacklogItemAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="backlog_id" value={backlogId} />
      <SubmitButton variant="primary" label="Restore to this week" />
    </form>
  );
}

function ArchiveForm({ backlogId }: { backlogId: string }) {
  const [, action] = useFormState(archiveBacklogItemAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="backlog_id" value={backlogId} />
      <SubmitButton variant="ghost" label="Archive" />
    </form>
  );
}

function SubmitButton({
  variant,
  label,
}: {
  variant: "primary" | "ghost";
  label: string;
}) {
  const { pending } = useFormStatus();
  const className = variant === "primary" ? "btn-primary" : "btn-ghost";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${className} disabled:opacity-60 text-xs`}
    >
      {pending ? "…" : label}
    </button>
  );
}
