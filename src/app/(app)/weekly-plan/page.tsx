import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getCurrentWeeklyPlan,
  listPlanItems,
} from "@/repositories/weekly-plan-repository";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import { CreateItemForm } from "./_create-item-form";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "approved",
  rejected: "rejected",
  scheduled: "scheduled",
  published: "published",
  skipped: "skipped",
  backlog: "backlog",
  paused: "paused",
};

export default async function WeeklyPlanPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar
          title="Weekly plan"
          description="Persistence not configured."
        />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="card p-5 text-sm text-ink-600">
            Supabase is not configured. Configure env vars to enable
            persisted weekly plans.
          </div>
        </div>
      </>
    );
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return (
      <>
        <Topbar title="Weekly plan" description="No workspace found." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl text-sm text-ink-600">
          Create a workspace to start planning.
        </div>
      </>
    );
  }

  const workspaceId = membership.workspace.id;
  const [plan, products, accounts] = await Promise.all([
    getCurrentWeeklyPlan(workspaceId),
    listProducts(workspaceId),
    listAccounts(workspaceId),
  ]);

  const items = plan ? await listPlanItems(workspaceId, plan.id) : [];

  return (
    <>
      <Topbar
        title="Weekly plan"
        description="Everything planned for this week, in one calm list."
        actions={
          plan ? (
            <Link href="/approval-queue" className="btn-primary">
              Open approval queue
            </Link>
          ) : null
        }
      />
      <div className="px-6 lg:px-10 py-8 max-w-3xl space-y-6">
        {!plan ? (
          <section className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              No weekly plan yet
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Add your first plan item below. Signal will create the
              week-of plan automatically.
            </p>
          </section>
        ) : items.length === 0 ? (
          <section className="card p-6 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              {plan.title}
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed">
              Week of {plan.weekStart}. No items yet.
            </p>
          </section>
        ) : (
          <section className="card">
            <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-ink-900">
                  {plan.title}
                </div>
                <div className="text-xs text-ink-500 mt-0.5">
                  Week of {plan.weekStart} · status: {plan.status}
                </div>
              </div>
              <div className="text-xs text-ink-500">
                {items.length} item{items.length === 1 ? "" : "s"}
              </div>
            </header>
            <ul className="row-divider">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="px-5 py-3.5 flex items-start justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-900">
                      {it.title ?? "Untitled"}
                    </div>
                    <div className="text-xs text-ink-500 mt-0.5">
                      {it.platform ?? "—"}
                      {it.contentType ? ` · ${it.contentType}` : ""}
                      {it.scheduledAt
                        ? ` · ${new Date(it.scheduledAt).toLocaleString()}`
                        : ""}
                    </div>
                    {it.body ? (
                      <p className="text-xs text-ink-700 mt-1 line-clamp-2">
                        {it.body}
                      </p>
                    ) : null}
                  </div>
                  <span className="badge-neutral text-[10px]">
                    {STATUS_LABELS[it.status] ?? it.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <CreateItemForm
          products={products.map((p) => ({ id: p.id, name: p.name }))}
          accounts={accounts.map((a) => ({
            id: a.id,
            displayName: a.displayName,
            platform: a.platform,
          }))}
        />
      </div>
    </>
  );
}
