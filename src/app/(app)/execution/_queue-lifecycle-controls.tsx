"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  authorizeQueueAction,
  cancelExecutionQueueAction,
  dryRunQueueAction,
  pauseExecutionQueueAction,
  queueWeeklyPlanItemsAction,
  resumeExecutionQueueAction,
  type DryRunQueueResult,
  type QueueItemsResult,
  type QueueLifecycleResult,
} from "./_actions";
import type { ExecutionQueueStatus } from "@/core/execution-engine";

const lifecycleInitial: QueueLifecycleResult = { ok: false, error: "" };
const itemsInitial: QueueItemsResult = { ok: false, error: "" };
const dryRunInitial: DryRunQueueResult = { ok: false, error: "" };

interface Props {
  queueId: string;
  status: ExecutionQueueStatus;
  contractActive: boolean;
  live: boolean;
}

export function QueueLifecycleControls({
  queueId,
  status,
  contractActive,
  live,
}: Props) {
  return (
    <section className="card p-5 space-y-3">
      <h2 className="text-sm font-semibold text-ink-900">Queue controls</h2>

      {(status === "draft" || status === "ready") && contractActive ? (
        <QueueItemsForm queueId={queueId} />
      ) : null}

      {status === "ready" || status === "running" ? (
        <DryRunForm queueId={queueId} />
      ) : null}

      {live && status !== "draft" ? (
        <AuthorizeQueueForm queueId={queueId} />
      ) : null}

      {(status === "ready" || status === "running") ? (
        <LifecycleButton
          queueId={queueId}
          action={pauseExecutionQueueAction}
          label="Pause queue"
          danger
        />
      ) : null}

      {status === "paused" ? (
        <LifecycleButton
          queueId={queueId}
          action={resumeExecutionQueueAction}
          label="Resume queue"
          danger={false}
        />
      ) : null}

      {live ? (
        <LifecycleButton
          queueId={queueId}
          action={cancelExecutionQueueAction}
          label="Cancel queue"
          danger
        />
      ) : null}

      {!live ? (
        <p className="text-xs text-ink-500">
          Queue is in a terminal state and cannot be modified.
        </p>
      ) : null}
    </section>
  );
}

function QueueItemsForm({ queueId }: { queueId: string }) {
  const [state, formAction] = useFormState(
    queueWeeklyPlanItemsAction,
    itemsInitial,
  );
  const safe = state ?? itemsInitial;
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="queue_id" value={queueId} />
      <Submit label="Queue approved plan items" />
      {safe.ok ? (
        <span className="text-xs text-green-700">
          Queued {safe.queued} item(s).
        </span>
      ) : safe.error ? (
        <span className="text-xs text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function DryRunForm({ queueId }: { queueId: string }) {
  const [state, formAction] = useFormState(dryRunQueueAction, dryRunInitial);
  const safe = state ?? dryRunInitial;
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="queue_id" value={queueId} />
      <Submit label="Dry-run queue" />
      {safe.ok ? (
        <span className="text-xs text-green-700">
          Evaluated {safe.evaluated} item(s). No external calls.
        </span>
      ) : safe.error ? (
        <span className="text-xs text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function AuthorizeQueueForm({ queueId }: { queueId: string }) {
  const [state, formAction] = useFormState(authorizeQueueAction, dryRunInitial);
  const safe = state ?? dryRunInitial;
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="queue_id" value={queueId} />
      <Submit label="Authorize all items" />
      {safe.ok ? (
        <span className="text-xs text-green-700">
          Authorized / evaluated {safe.evaluated} item(s).
        </span>
      ) : safe.error ? (
        <span className="text-xs text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function LifecycleButton({
  queueId,
  action,
  label,
  danger,
}: {
  queueId: string;
  action: (
    prev: QueueLifecycleResult,
    fd: FormData,
  ) => Promise<QueueLifecycleResult>;
  label: string;
  danger: boolean;
}) {
  const [state, formAction] = useFormState(action, lifecycleInitial);
  const safe = state ?? lifecycleInitial;
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="queue_id" value={queueId} />
      <Submit label={label} danger={danger} />
      {!safe.ok && safe.error ? (
        <span className="text-xs text-red-700">{safe.error}</span>
      ) : null}
    </form>
  );
}

function Submit({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  const className = danger ? "btn-secondary text-xs" : "btn-primary text-xs";
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : label}
    </button>
  );
}
