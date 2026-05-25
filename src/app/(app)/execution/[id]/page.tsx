import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getExecutionQueueById } from "@/repositories/execution-queue-repository";
import { listItemsForQueue } from "@/repositories/execution-item-repository";
import { listLogsForQueue } from "@/repositories/execution-log-repository";
import { ExecutionLogLine } from "@/components/publishing/execution-log-line";
import { listAttemptsForItem } from "@/repositories/execution-attempt-repository";
import { getWeeklyContractById } from "@/repositories/weekly-contract-repository";
import { RepositoryError } from "@/repositories/errors";
import {
  EXECUTION_ITEM_STATUS_LABELS,
  EXECUTION_QUEUE_STATUS_LABELS,
  isQueueLive,
} from "@/core/execution-engine";
import { QueueLifecycleControls } from "../_queue-lifecycle-controls";
import { ItemControls } from "../_item-controls";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { id: string };
}

export default async function ExecutionQueueDetailPage({ params }: PageProps) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Execution queue" description="Persistence not configured." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Configure Supabase first.
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Execution queue" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace first.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  let queue;
  try {
    queue = await getExecutionQueueById(workspaceId, params.id);
  } catch (err) {
    if (err instanceof RepositoryError && err.code === "not_found") {
      notFound();
    }
    throw err;
  }

  // Contract-free queues (per-post path) have queue.contractId === null.
  // Skip the contract lookup in that case; the UI renders a small
  // "contract-free" badge below.
  const [contract, items, logs] = await Promise.all([
    queue.contractId
      ? getWeeklyContractById(workspaceId, queue.contractId)
      : Promise.resolve(null),
    listItemsForQueue(workspaceId, queue.id),
    listLogsForQueue(workspaceId, queue.id, 100),
  ]);

  // Pull attempts for the items shown so the per-item panel can render
  // recent attempts.
  const attemptsByItem = new Map<
    string,
    Awaited<ReturnType<typeof listAttemptsForItem>>
  >();
  await Promise.all(
    items.slice(0, 50).map(async (i) => {
      const a = await listAttemptsForItem(workspaceId, i.id);
      attemptsByItem.set(i.id, a);
    }),
  );

  return (
    <>
      <Topbar
        title={queue.title}
        description={`Execution queue · ${queue.weekStart} → ${queue.weekEnd}`}
        actions={
          <Link href="/execution" className="btn-secondary text-xs">
            ← All queues
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <p className="text-xs text-ink-700 leading-relaxed">
            <strong>Dry-run only.</strong> No external platform publishing
            happens in this phase. Authorize and dry-run actions log what{" "}
            <em>would</em> happen and update item statuses accordingly.
          </p>
        </section>

        <section className="card p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">
              Status: {EXECUTION_QUEUE_STATUS_LABELS[queue.status]}
            </div>
            {contract ? (
              <div className="text-xs text-ink-500">
                Contract:{" "}
                <Link
                  href={`/weekly-contracts/${contract.id}`}
                  className="text-signal-700 hover:underline"
                >
                  {contract.title}
                </Link>
              </div>
            ) : (
              <div className="text-xs text-ink-500">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded border border-ink-200 bg-ink-50 font-mono text-[10px] text-ink-600">
                  contract-free queue
                </span>
              </div>
            )}
          </div>
          {contract && contract.status !== "active" ? (
            <p className="text-xs text-red-700 mt-2">
              Contract is currently &ldquo;{contract.status}&rdquo;. Activate
              it before queueing or dry-running.
            </p>
          ) : null}
        </section>

        <QueueLifecycleControls
          queueId={queue.id}
          status={queue.status}
          // Contract-free queues don't require an active contract to run.
          contractActive={!contract || contract.status === "active"}
          live={isQueueLive(queue.status)}
        />

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Items ({items.length})
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Each item walks pending_authorization → authorized → completed /
              backlogged / skipped / blocked.
            </p>
          </header>
          {items.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No items in this queue yet. Queue approved weekly plan items
              from the lifecycle controls above.
            </div>
          ) : (
            <ul className="row-divider">
              {items.map((it) => {
                const attempts = attemptsByItem.get(it.id) ?? [];
                return (
                  <li key={it.id} className="px-5 py-3.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm text-ink-900">
                          {it.title ?? "(untitled)"}
                        </div>
                        <div className="text-[11px] text-ink-500 mt-0.5">
                          {it.actionType}
                          {it.platform ? ` · ${it.platform}` : ""}
                          {it.scheduledAt
                            ? ` · ${new Date(it.scheduledAt).toLocaleString()}`
                            : ""}
                        </div>
                        <div className="text-[11px] text-ink-400 mt-0.5">
                          attempts {it.attemptCount}/{it.maxAttempts} · risk{" "}
                          {it.riskLevel ?? "—"}
                        </div>
                        {it.body ? (
                          <p className="text-xs text-ink-700 mt-1 line-clamp-2">
                            {it.body}
                          </p>
                        ) : null}
                        {attempts.length > 0 ? (
                          <ul className="text-[11px] text-ink-500 mt-1 space-y-0.5">
                            {attempts.slice(-3).map((a) => (
                              <li key={a.id}>
                                #{a.attemptNumber} · {a.status}
                                {a.errorSummary ? ` — ${a.errorSummary}` : ""}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                      <span className="badge-neutral text-[10px] whitespace-nowrap">
                        {EXECUTION_ITEM_STATUS_LABELS[it.status]}
                      </span>
                    </div>
                    <div className="mt-2">
                      <ItemControls itemId={it.id} status={it.status} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Execution logs
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Newest first. Append-only.
            </p>
          </header>
          {logs.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">No logs yet.</div>
          ) : (
            <ul>
              {logs.map((l) => (
                <ExecutionLogLine
                  key={l.id}
                  row={{
                    id: l.id,
                    eventType: l.eventType,
                    severity: l.severity,
                    message: l.message,
                    metadata: l.metadata as Record<string, unknown> | null,
                    createdAt: l.createdAt,
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
