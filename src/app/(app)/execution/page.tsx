import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getActiveContract } from "@/repositories/weekly-contract-repository";
import { listExecutionQueues } from "@/repositories/execution-queue-repository";
import {
  listUpcomingScheduledItems,
  listRecentResultItems,
} from "@/repositories/execution-item-repository";
import { EXECUTION_QUEUE_STATUS_LABELS } from "@/core/execution-engine";
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

  const [contract, queues, upcoming, recent] = await Promise.all([
    getActiveContract(membership.workspace.id),
    listExecutionQueues(membership.workspace.id),
    listUpcomingScheduledItems(membership.workspace.id, 10),
    listRecentResultItems(membership.workspace.id, 10),
  ]);

  return (
    <>
      <Topbar
        title="Publishing activity"
        description="What Signal is about to publish, and what's already gone out. Posts only — comments and drafts live on the weekly plan."
      />

      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl space-y-5">
        <section className="rounded-2xl border border-ink-200 bg-white">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Coming up
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                Approved posts waiting for their scheduled time.
              </p>
            </div>
            <div className="text-xs text-ink-500">{upcoming.length} shown</div>
          </header>
          {upcoming.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              Nothing queued. Approve a weekly plan to start publishing.
            </div>
          ) : (
            <ul className="row-divider">
              {upcoming.map((it) => (
                <li
                  key={it.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/execution/items/${it.id}`}
                      className="text-sm font-medium text-ink-900 truncate hover:text-signal-700"
                    >
                      {it.title ?? "Untitled"}
                    </Link>
                    <div className="text-[11px] text-ink-500 mt-0.5">
                      {it.platform ?? "—"} ·{" "}
                      {it.scheduledAt
                        ? new Date(it.scheduledAt).toLocaleString(undefined, {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })
                        : "scheduled time pending"}
                    </div>
                  </div>
                  <span className="badge-info text-[10px]">scheduled</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-ink-200 bg-white">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">
                Recent publishes
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                The most recent posts Signal handled, with their outcome.
              </p>
            </div>
            <div className="text-xs text-ink-500">{recent.length} shown</div>
          </header>
          {recent.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No publishes yet.
            </div>
          ) : (
            <ul className="row-divider">
              {recent.map((it) => (
                <li
                  key={it.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/execution/items/${it.id}`}
                      className="text-sm font-medium text-ink-900 truncate hover:text-signal-700"
                    >
                      {it.title ?? "Untitled"}
                    </Link>
                    <div className="text-[11px] text-ink-500 mt-0.5">
                      {it.platform ?? "—"} · updated{" "}
                      {new Date(it.updatedAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                  <span
                    className={`text-[10px] ${
                      it.status === "completed"
                        ? "badge-low"
                        : it.status === "failed"
                        ? "badge-high"
                        : "badge-neutral"
                    }`}
                  >
                    {friendlyStatus(it.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

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
                Publishing batches
              </div>
              <p className="text-xs text-ink-500 mt-0.5">
                Each batch groups the posts going out under one weekly scope.
              </p>
            </div>
            <div className="text-xs text-ink-500">{queues.length} total</div>
          </header>
          {queues.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No batches yet.{" "}
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

function friendlyStatus(status: string): string {
  switch (status) {
    case "completed":
      return "published";
    case "failed":
      return "failed";
    case "ready":
      return "ready";
    case "ready_for_manual_publish":
      return "manual publish";
    case "blocked":
      return "blocked";
    case "skipped":
      return "skipped";
    case "running":
      return "publishing…";
    case "scheduled":
      return "scheduled";
    default:
      return status;
  }
}
