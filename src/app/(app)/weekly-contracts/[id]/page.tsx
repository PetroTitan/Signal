import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { getWeeklyContractById } from "@/repositories/weekly-contract-repository";
import { listExecutionAuthorizationsForContract } from "@/repositories/execution-authorization-repository";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import {
  WEEKLY_CONTRACT_ACTION_LABELS,
  WEEKLY_CONTRACT_STATUS_LABELS,
  EXECUTION_AUTHORIZATION_REASON_LABELS,
  type WeeklyContractActionType,
  type ExecutionAuthorizationReasonCode,
} from "@/core/weekly-contract";
import { ContractLifecycleControls } from "../_lifecycle-controls";
import { RepositoryError } from "@/repositories/errors";

export const dynamic = "force-dynamic";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface PageProps {
  params: { id: string };
}

export default async function WeeklyContractDetailPage({ params }: PageProps) {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Weekly contract"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Configure Supabase to view contracts.
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Weekly contract" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace first.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  let contract;
  try {
    contract = await getWeeklyContractById(workspaceId, params.id);
  } catch (err) {
    if (err instanceof RepositoryError && err.code === "not_found") {
      notFound();
    }
    throw err;
  }

  const [authorizations, products, accounts] = await Promise.all([
    listExecutionAuthorizationsForContract(workspaceId, contract.id, 50),
    listProducts(workspaceId),
    listAccounts(workspaceId),
  ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const productById = new Map(products.map((p) => [p.id, p]));

  const expectedPhrase = `approve ${contract.title}`;

  return (
    <>
      <Topbar
        title={contract.title}
        description={`Weekly operating contract · ${contract.weekStart} → ${contract.weekEnd}`}
        actions={
          <Link href="/weekly-contracts" className="btn-secondary text-xs">
            ← All contracts
          </Link>
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">
              Status: {WEEKLY_CONTRACT_STATUS_LABELS[contract.status]}
            </div>
            <div className="text-xs text-ink-500">
              Risk ≤ {contract.maxRiskLevel}
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-ink-700">
            <div>
              <dt className="text-ink-500">Created</dt>
              <dd>{contract.createdAt}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Approved at</dt>
              <dd>{contract.approvedAt ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-ink-500">Activated at</dt>
              <dd>{contract.activatedAt ?? "—"}</dd>
            </div>
          </dl>
          {contract.notes ? (
            <p className="mt-3 text-sm text-ink-700 leading-relaxed">
              {contract.notes}
            </p>
          ) : null}
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Cadence ceiling</h2>
          <ul className="mt-2 text-sm text-ink-700 space-y-1">
            <li>Per week: {contract.maxActionsTotal ?? "no cap"}</li>
            <li>Per day: {contract.maxActionsPerDay ?? "no cap"}</li>
            <li>Per platform / day: {contract.maxActionsPerPlatformPerDay ?? "no cap"}</li>
            <li>
              Pause on first failure:{" "}
              {contract.pauseOnFirstFailure ? "yes" : "no"} · Pause on risk event:{" "}
              {contract.pauseOnRiskEvent ? "yes" : "no"}
            </li>
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Scope</h2>

          <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-ink-700">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Accounts
              </div>
              {contract.scope.accountIds.length === 0 ? (
                <p className="text-xs text-ink-500">No accounts in scope.</p>
              ) : (
                <ul className="text-xs space-y-0.5">
                  {contract.scope.accountIds.map((id) => {
                    const a = accountById.get(id);
                    return (
                      <li key={id}>
                        {a
                          ? `${a.displayName ?? a.handle ?? "(unnamed)"} — ${a.platform}`
                          : id}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Products
              </div>
              {contract.scope.productIds.length === 0 ? (
                <p className="text-xs text-ink-500">No products in scope.</p>
              ) : (
                <ul className="text-xs space-y-0.5">
                  {contract.scope.productIds.map((id) => {
                    const p = productById.get(id);
                    return <li key={id}>{p ? p.name : id}</li>;
                  })}
                </ul>
              )}
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Platforms
              </div>
              {contract.scope.platforms.length === 0 ? (
                <p className="text-xs text-ink-500">None.</p>
              ) : (
                <ul className="text-xs space-y-0.5">
                  {contract.scope.platforms.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Allowed actions
              </div>
              {contract.scope.allowedActions.length === 0 ? (
                <p className="text-xs text-ink-500">No actions allowed.</p>
              ) : (
                <ul className="text-xs space-y-0.5">
                  {contract.scope.allowedActions.map((a) => (
                    <li key={a}>
                      {WEEKLY_CONTRACT_ACTION_LABELS[a as WeeklyContractActionType] ?? a}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="md:col-span-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 mb-1">
                Execution windows
              </div>
              {contract.scope.executionWindows.length === 0 ? (
                <p className="text-xs text-ink-500">
                  No windows defined — Signal may execute any time the
                  contract is active.
                </p>
              ) : (
                <ul className="text-xs space-y-0.5">
                  {contract.scope.executionWindows.map((w) => (
                    <li key={w.id}>
                      {DAY_LABELS[w.dayOfWeek]} {w.startTime}–{w.endTime}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <ContractLifecycleControls
          contractId={contract.id}
          status={contract.status}
          expectedPhrase={expectedPhrase}
        />

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100">
            <div className="text-sm font-semibold text-ink-900">
              Recent execution authorizations
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              The audit trail of every &ldquo;can this action run?&rdquo;
              decision tied to this contract.
            </p>
          </header>
          {authorizations.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No execution authorizations yet.
            </div>
          ) : (
            <ul className="row-divider">
              {authorizations.map((a) => (
                <li key={a.id} className="px-5 py-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-mono">{a.actionType}</span>{" "}
                      {a.platform ? (
                        <span className="text-ink-500">({a.platform})</span>
                      ) : null}
                    </div>
                    <span
                      className={
                        a.outcome === "allowed"
                          ? "text-green-700"
                          : a.outcome === "soft_block"
                          ? "text-amber-700"
                          : "text-red-700"
                      }
                    >
                      {a.outcome}
                    </span>
                  </div>
                  <div className="text-ink-500 mt-1">
                    {EXECUTION_AUTHORIZATION_REASON_LABELS[
                      a.reasonCode as ExecutionAuthorizationReasonCode
                    ] ?? a.reasonCode}
                    {a.reasonDetail ? ` — ${a.reasonDetail}` : ""}
                  </div>
                  <div className="text-ink-400 mt-0.5">{a.createdAt}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
