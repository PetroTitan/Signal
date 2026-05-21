import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Topbar } from "@/components/topbar";
import {
  PlatformBadge,
  AccountStatusBadge,
} from "@/components/badges";
import { CheckIcon, DotIcon, LockIcon } from "@/components/icons";
import { accountsById, accounts, productsById } from "@/lib/mock";

type Params = { params: { id: string } };

export function generateStaticParams() {
  return accounts.map((a) => ({ id: a.id }));
}

export function generateMetadata({ params }: Params): Metadata {
  const a = accountsById[params.id];
  if (!a) return { title: "Account not found" };
  return { title: a.displayName };
}

export default function AccountSetupPage({ params }: Params) {
  const account = accountsById[params.id];
  if (!account) notFound();
  const product = productsById[account.productId];

  return (
    <>
      <Topbar
        title={account.displayName}
        description={`${product.name} · ${capitalize(account.role)}`}
        actions={
          <button
            type="button"
            disabled
            className="btn-primary opacity-60 cursor-not-allowed inline-flex items-center gap-2"
            title="OAuth providers not yet integrated"
          >
            <LockIcon />
            Connect via official OAuth
          </button>
        }
      />

      <div className="px-6 lg:px-8 py-6 max-w-5xl space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="card-padded">
            <div className="stat-label">Platform</div>
            <div className="mt-2"><PlatformBadge platform={account.platform} /></div>
          </div>
          <div className="card-padded">
            <div className="stat-label">Status</div>
            <div className="mt-2"><AccountStatusBadge status={account.status} /></div>
          </div>
          <div className="card-padded">
            <div className="stat-label">Readiness</div>
            <div className="stat-value mt-1">{account.readinessScore}%</div>
          </div>
        </div>

        <section className="card">
          <SectionHeader
            title="Setup checklist"
            hint="Signal does not perform the steps for you. Complete them manually, then mark the account ready."
          />
          <ul className="row-divider">
            {account.setup.checklist.map((item, i) => (
              <li key={i} className="px-5 py-3 flex items-center gap-3">
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full ${
                    item.done
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-ink-100 text-ink-400"
                  }`}
                >
                  {item.done ? (
                    <CheckIcon width={12} height={12} />
                  ) : (
                    <DotIcon width={10} height={10} />
                  )}
                </span>
                <span
                  className={`text-sm ${
                    item.done ? "text-ink-500 line-through" : "text-ink-800"
                  }`}
                >
                  {item.label}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card title="Username ideas">
            {account.setup.usernameIdeas.length === 0 ? (
              <p className="text-sm text-ink-500">
                Handle already chosen.
              </p>
            ) : (
              <ul className="text-sm text-ink-800 space-y-1 font-mono">
                {account.setup.usernameIdeas.map((u) => (
                  <li key={u}>· {u}</li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Bio / headline suggestions">
            <ul className="text-sm text-ink-800 space-y-2">
              {account.setup.bioSuggestions.map((b) => (
                <li
                  key={b}
                  className="border-l-2 border-ink-100 pl-3 leading-relaxed"
                >
                  {b}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Avatar brief">
            <p className="text-sm text-ink-800">{account.setup.avatarBrief}</p>
          </Card>

          <Card title="Cover brief">
            <p className="text-sm text-ink-800">
              {account.setup.coverBrief === "n/a"
                ? "Platform does not use a cover image."
                : account.setup.coverBrief}
            </p>
          </Card>
        </div>

        <section className="card">
          <SectionHeader
            title="First-week warm-up plan"
            hint="Calm cadence. No promotional posts until warm-up is complete."
          />
          <ol className="px-5 py-4 space-y-2 text-sm text-ink-800 list-decimal list-inside">
            {account.setup.warmUpPlan.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>

        <section className="card border-signal-200 bg-signal-50/40">
          <div className="p-4 flex items-start gap-3">
            <LockIcon className="text-signal-700 mt-0.5" />
            <div className="text-sm">
              <div className="font-semibold text-ink-900">
                OAuth connection
              </div>
              <p className="text-ink-700 mt-0.5 leading-relaxed">
                When platform OAuth integrations are live, this account will
                connect through {prettyPlatform(account.platform)}&apos;s
                authorization flow. Signal will never request or store your
                password.
              </p>
              <button
                type="button"
                disabled
                className="btn-primary opacity-60 cursor-not-allowed mt-3 inline-flex items-center gap-2"
              >
                <LockIcon />
                Connect via {prettyPlatform(account.platform)} OAuth (not yet available)
              </button>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="px-5 py-3.5 border-b border-ink-100 text-sm font-semibold text-ink-900">
        {title}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-5 py-3.5 border-b border-ink-100">
      <div className="text-sm font-semibold text-ink-900">{title}</div>
      {hint ? <div className="text-xs text-ink-500 mt-0.5">{hint}</div> : null}
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function prettyPlatform(p: string) {
  return p === "x" ? "X" : p === "reddit" ? "Reddit" : "LinkedIn";
}
