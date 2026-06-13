import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getActiveContract } from "@/repositories/weekly-contract-repository";
import { listExecutionQueues } from "@/repositories/execution-queue-repository";
import { EXECUTION_QUEUE_STATUS_LABELS } from "@/core/execution-engine";
import { countExecutionItemsByStatus } from "@/repositories/execution-item-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import { computeSchedulerHealth } from "@/core/publishing/scheduler-health";
import { SchedulerHealthCard } from "@/components/publishing/scheduler-health-card";
import { CreateQueueForm } from "./_create-queue-form";

export const dynamic = "force-dynamic";

export default async function ExecutionIndexPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Publishing activity"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Configure Supabase to track publishing activity.
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Publishing activity" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace before publishing.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  const [contract, queues, scheduledCount, retryQueueCount, runningNowCount, recentPublishes] =
    await Promise.all([
      getActiveContract(workspaceId),
      listExecutionQueues(workspaceId),
      countExecutionItemsByStatus(workspaceId, ["scheduled"]),
      countExecutionItemsByStatus(workspaceId, ["scheduled"], { minAttemptCount: 1 }),
      countExecutionItemsByStatus(workspaceId, ["running"]),
      listRecentPublishes(workspaceId, 1),
    ]);

  // B7 — heartbeat from real, observable state only.
  const lastPublished = recentPublishes.find((p) => p.outcome === "published");
  const schedulerHealth = computeSchedulerHealth({
    scheduledCount,
    retryQueueCount,
    runningNowCount,
    lastObservedPublishAtIso: lastPublished?.finishedAt ?? null,
    now: new Date(),
  });

  return (
    <>
      <Topbar
        title="Publishing"
        description="Active publishing scope and history. Today, tomorrow, and recent publishes live on the dashboard."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl space-y-5">
        <SchedulerHealthCard health={schedulerHealth} />

        <section className="rounded-2xl border border-ink-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-ink-900">
            Active publishing scope
          </h2>
          {contract ? (
            <div className="mt-2 text-sm text-ink-700">
              <div className="font-medium">
                <Link
                  href={`/weekly-contracts/${contract.id}`}
                  className="hover:text-signal-700"
                >
                  {contract.title}
                </Link>
              </div>
              <div className="text-xs text-ink-500 mt-0.5">
                {contract.weekStart} → {contract.weekEnd} · risk ceiling{" "}
                {contract.maxRiskLevel} ·{" "}
                {contract.scope.allowedActions.length} action
                {contract.scope.allowedActions.length === 1 ? "" : "s"} allowed
              </div>
            </div>
          ) : (
            <div className="mt-2 text-sm text-ink-600">
              No active publishing scope for this week. Set one up on{" "}
              <Link href="/weekly-contracts" className="text-signal-700 underline">
                Publishing scope
              </Link>{" "}
              before queuing posts.
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-ink-200 bg-white">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Publishing history
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                Each week&apos;s posts grouped under their publishing scope.
              </p>
            </div>
            <div className="text-xs text-ink-500">{queues.length} total</div>
          </header>
          {queues.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              Nothing here yet.{" "}
              {contract
                ? "Create one below."
                : "Activate a publishing scope first."}
            </div>
          ) : (
            <ul className="row-divider">
              {queues.map((q) => (
                <li
                  key={q.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/execution/${q.id}`}
                      className="text-sm font-medium text-ink-900 hover:text-signal-700"
                    >
                      {q.title}
                    </Link>
                    <div className="text-xs text-ink-500 mt-0.5">
                      {q.weekStart} → {q.weekEnd}
                    </div>
                  </div>
                  <span className="badge-neutral text-[10px]">
                    {EXECUTION_QUEUE_STATUS_LABELS[q.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {contract ? <CreateQueueForm /> : null}
      </div>
    </>
  );
}
