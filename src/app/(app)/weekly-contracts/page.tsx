import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listWeeklyContracts } from "@/repositories/weekly-contract-repository";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import {
  WEEKLY_CONTRACT_ACTION_LABELS,
  WEEKLY_CONTRACT_ACTION_TYPES,
  WEEKLY_CONTRACT_ENVELOPE_RULES,
  WEEKLY_CONTRACT_POLICY_GRANTED,
  WEEKLY_CONTRACT_POLICY_NEVER_GRANTED,
  WEEKLY_CONTRACT_POLICY_RESTRICTED,
  WEEKLY_CONTRACT_STATUS_LABELS,
} from "@/core/weekly-contract";
import { CreateContractForm } from "./_create-contract-form";

export const dynamic = "force-dynamic";

const PLATFORM_OPTIONS = ["reddit", "x", "linkedin"] as const;

function isoMonday(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  if (day !== 1) d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function WeeklyContractsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Weekly contracts"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured. Configure env vars to enable weekly
            operating contracts.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Weekly contracts" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace before granting weekly approval.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  const [contracts, products, accounts] = await Promise.all([
    listWeeklyContracts(workspaceId),
    listProducts(workspaceId),
    listAccounts(workspaceId),
  ]);

  const monday = isoMonday(new Date());
  const sunday = addDaysIso(monday, 6);

  return (
    <>
      <Topbar
        title="Weekly contracts"
        description="Approve once per week. Signal operates only within the envelope you grant."
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Operating model</h2>
          <p className="text-sm text-ink-700 mt-2 leading-relaxed">
            The weekly contract is the only thing that authorizes Signal to
            act on your behalf. Without an <span className="font-mono text-xs">active</span> contract,
            every write-side action is hard-blocked. With one, Signal stays
            inside its scope until the week ends or you pause it.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">What an active contract grants</h2>
          <ul className="mt-2 list-disc list-inside text-sm text-ink-700 space-y-1">
            {WEEKLY_CONTRACT_POLICY_GRANTED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="card p-5">
          <h2 className="text-sm font-semibold text-ink-900">Always restricted</h2>
          <ul className="mt-2 list-disc list-inside text-sm text-ink-700 space-y-1">
            {WEEKLY_CONTRACT_POLICY_RESTRICTED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="card p-5 border-amber-200 bg-amber-50/40">
          <h2 className="text-sm font-semibold text-ink-900">Never granted</h2>
          <ul className="mt-2 list-disc list-inside text-sm text-ink-700 space-y-1">
            {WEEKLY_CONTRACT_POLICY_NEVER_GRANTED.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="card">
          <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-ink-900">Contracts</div>
              <p className="text-xs text-ink-500 mt-0.5">
                One row per weekly envelope.
              </p>
            </div>
            <div className="text-xs text-ink-500">
              {contracts.length} total
            </div>
          </header>
          {contracts.length === 0 ? (
            <div className="px-5 py-6 text-sm text-ink-600">
              No weekly contracts yet. Draft your first one below.
            </div>
          ) : (
            <ul className="row-divider">
              {contracts.map((c) => (
                <li
                  key={c.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/weekly-contracts/${c.id}`}
                      className="text-sm font-medium text-ink-900 hover:text-signal-700"
                    >
                      {c.title}
                    </Link>
                    <div className="text-xs text-ink-500 mt-0.5">
                      {c.weekStart} → {c.weekEnd} · risk ≤ {c.maxRiskLevel}
                    </div>
                    <div className="text-xs text-ink-500 mt-0.5">
                      {c.scope.accountIds.length} account(s), {c.scope.platforms.length} platform(s), {c.scope.allowedActions.length} action(s)
                    </div>
                  </div>
                  <span className="badge-neutral text-[10px]">
                    {WEEKLY_CONTRACT_STATUS_LABELS[c.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <CreateContractForm
          defaultWeekStart={monday}
          defaultWeekEnd={sunday}
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          accounts={accounts.map((a) => ({
            id: a.id,
            displayName: a.displayName ?? a.handle ?? "(unnamed)",
            platform: a.platform,
          }))}
          platforms={[...PLATFORM_OPTIONS]}
          actionTypes={WEEKLY_CONTRACT_ACTION_TYPES.map((t) => ({
            value: t,
            label: WEEKLY_CONTRACT_ACTION_LABELS[t],
          }))}
        />

        <section className="card p-5 text-xs text-ink-600 leading-relaxed">
          <div className="font-semibold text-ink-900 mb-1">Envelope rules</div>
          <ul className="list-disc list-inside space-y-1">
            {WEEKLY_CONTRACT_ENVELOPE_RULES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
