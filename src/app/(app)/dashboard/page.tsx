import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { LockIcon } from "@/components/icons";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import {
  getCurrentWeeklyPlan,
  listPlanItemsByStatus,
} from "@/repositories/weekly-plan-repository";
import { listRecentActivity } from "@/repositories/activity-repository";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Welcome"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured. Set the env vars on this deployment
            to start using Signal.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Welcome" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          The workspace bootstrap did not complete. Sign out and sign back
          in to retry.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  const [products, accounts, plan, activity] = await Promise.all([
    listProducts(workspaceId),
    listAccounts(workspaceId),
    getCurrentWeeklyPlan(workspaceId),
    listRecentActivity(workspaceId, 6),
  ]);

  const pending = plan
    ? await listPlanItemsByStatus(workspaceId, ["pending_approval"])
    : [];

  const hasAnyData =
    products.length > 0 || accounts.length > 0 || pending.length > 0;

  if (!hasAnyData) {
    return (
      <>
        <Topbar
          title="Welcome"
          description="A calm operating surface for sustainable growth."
        />
        <div className="px-6 lg:px-10 py-16 max-w-2xl space-y-10">
          <section>
            <h2 className="text-base font-semibold text-ink-900">
              Start with one product, one account.
            </h2>
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              Signal turns founder observations into platform-native
              opportunities, distributes them across a calm week, and
              never publishes without your approval.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/products" className="btn-primary">
                Create a product profile
              </Link>
              <Link href="/accounts" className="btn">
                Add your first account
              </Link>
            </div>
          </section>

          <section className="card p-4 flex items-start gap-3 text-sm">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
              <LockIcon />
            </span>
            <div>
              <div className="font-semibold text-ink-900">
                OAuth-first by design
              </div>
              <p className="text-ink-700 mt-0.5 leading-relaxed">
                Signal never asks for platform passwords. Accounts connect
                through OAuth when integrations are enabled.
              </p>
            </div>
          </section>

          <section className="text-xs text-ink-500 leading-relaxed">
            <p>
              AI generation, platform OAuth, and WebmasterID analytics are
              not connected yet.
            </p>
          </section>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="This week"
        description="Real workspace state. Calm review, single approval gate."
        actions={
          pending.length > 0 ? (
            <Link href="/approval-queue" className="btn-primary">
              Review {pending.length}
            </Link>
          ) : null
        }
      />

      <div className="px-6 lg:px-10 py-8 max-w-4xl space-y-6">
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Products" value={products.length} href="/products" />
          <Stat label="Accounts" value={accounts.length} href="/accounts" />
          <Stat
            label="Pending review"
            value={pending.length}
            href="/approval-queue"
          />
          <Stat
            label="Current plan"
            value={plan ? plan.weekStart : "—"}
            href="/weekly-plan"
            isText={!plan}
          />
        </section>

        <section className="card p-5">
          <header className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-ink-900">
              Recent activity
            </div>
            <Link
              href="/activity"
              className="text-xs text-signal-700 hover:text-signal-800"
            >
              Open feed →
            </Link>
          </header>
          {activity.length === 0 ? (
            <p className="text-xs text-ink-500">
              No activity yet. Events show here as you add products, accounts,
              and approve plan items.
            </p>
          ) : (
            <ul className="space-y-2 text-xs">
              {activity.slice(0, 6).map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-3 border-b border-ink-100 pb-2 last:border-b-0 last:pb-0"
                >
                  <span className="font-mono text-[10px] text-ink-500 shrink-0 w-32 truncate">
                    {e.eventType}
                  </span>
                  <span className="flex-1 min-w-0 text-ink-800">
                    {e.title}
                  </span>
                  <span className="text-[11px] text-ink-500 font-mono shrink-0">
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-5 text-xs text-ink-600 leading-relaxed">
          <div className="font-semibold text-ink-900 mb-1">Not connected</div>
          AI generation, platform OAuth, and WebmasterID analytics are not
          wired yet. Drafts and approvals stay local to Signal until those
          integrations ship.
        </section>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  href,
  isText = false,
}: {
  label: string;
  value: number | string;
  href: string;
  isText?: boolean;
}) {
  return (
    <Link
      href={href}
      className="card p-4 hover:border-signal-300 transition-colors block"
    >
      <div className="text-[10px] uppercase tracking-wide text-ink-500 font-semibold">
        {label}
      </div>
      <div
        className={`${isText ? "text-sm" : "text-2xl"} font-semibold text-ink-900 mt-1`}
      >
        {value}
      </div>
    </Link>
  );
}
