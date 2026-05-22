import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getActiveContract } from "@/repositories/weekly-contract-repository";
import { listExecutionQueues } from "@/repositories/execution-queue-repository";
import { EXECUTION_QUEUE_STATUS_LABELS } from "@/core/execution-engine";
import { CreateQueueForm } from "./_create-queue-form";

export const dynamic = "force-dynamic";

export default async function ExecutionIndexPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Execution"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Configure Supabase to use the execution engine.
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Execution" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace before running the execution engine.
        </div>
      </>
    );
  }

  const [contract, queues] = await Promise.all([
    getActiveContract(membership.workspace.id),
    listExecutionQueues(membership.workspace.id),
  ]);

  return (
    <>
      <Topbar
        title="Execution"
        description="Carry out approved weekly operations under the active contract. Dry-run only — no external platform publishing happens in this phase."
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-ink-900">
            Dry-run only
          </h2>
          <p className="text-xs text-ink-700 mt-1 leading-relaxed">
            Phase E2 implements the safety state machine, contract
            authorization, and a dry-run executor. Nothing in this surface
            calls an external platform API. The runner describes what{" "}
            <em>would</em> happen and records it in execution_logs and
            execution_attempts.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Active contract</h2>
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
                {contract.weekStart} → {contract.weekEnd} · risk ≤{" "}
                {contract.maxRiskLevel} ·{" "}
                {contract.scope.allowedActions.length} action(s) allowed
              </div>
            </div>
          ) : (
            <div className="mt-2 text-sm text-ink-600">
              No active weekly contract. Create one at{" "}
              <Link href="/weekly-contracts" className="text-signal-700 underline">
                /weekly-contracts
              </Link>{" "}
              before queuing execution.
            </div>
          )}
        </section>

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">Queues</div>
              <p className="text-xs text-ink-500 mt-0.5">
                One row per execution envelope, scoped to a weekly contract.
              </p>
            </div>
            <div className="text-xs text-ink-500">{queues.length} total</div>
          </header>
          {queues.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No execution queues yet.{" "}
              {contract
                ? "Create one below."
                : "Activate a weekly contract first."}
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
