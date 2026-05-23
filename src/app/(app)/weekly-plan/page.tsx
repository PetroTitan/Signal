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
import {
  creativeReadinessBadge,
  creativeReadinessReason,
  listCreativesForItems,
} from "@/repositories/weekly-plan-creative-repository";
import { listExecutionItemsByPlanItemIds } from "@/repositories/execution-item-repository";
import { CreateItemForm } from "./_create-item-form";
import { ApprovePlanForm } from "./_approve-plan-form";
import { PlanItemRow } from "./_item-row";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  draft: "draft",
  pending_approval: "pending",
  approved: "approved",
  rejected: "rejected",
  scheduled: "scheduled",
  published: "published",
  failed: "failed",
  skipped: "skipped",
  backlog: "backlog",
  paused: "paused",
};

const STATUS_BADGE: Record<string, string> = {
  draft: "badge-neutral",
  pending_approval: "badge-medium",
  approved: "badge-info",
  rejected: "badge-neutral",
  scheduled: "badge-info",
  published: "badge-low",
  failed: "badge-high",
  skipped: "badge-neutral",
  backlog: "badge-neutral",
  paused: "badge-neutral",
};

function badgeClass(status: string): string {
  return STATUS_BADGE[status] ?? "badge-neutral";
}

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

  const creatives = items.length
    ? await listCreativesForItems(
        workspaceId,
        items.map((i) => i.id),
      )
    : [];
  const creativeByItem = new Map<string, (typeof creatives)[number]>();
  for (const c of creatives) {
    if (!creativeByItem.has(c.weeklyPlanItemId)) {
      creativeByItem.set(c.weeklyPlanItemId, c);
    }
  }

  // Phase F2.5: map plan_item_id → most-recent execution_item so the
  // row can show "ready_for_publish" with a link to /execution/items/<id>.
  const execItems = items.length
    ? await listExecutionItemsByPlanItemIds(
        workspaceId,
        items.map((i) => i.id),
      )
    : [];
  const execByPlanItem = new Map<
    string,
    { id: string; status: string }
  >();
  for (const ei of execItems) {
    const prev = execByPlanItem.get(ei.sourceEntityId ?? "");
    // Prefer the most-recent / most-advanced status.
    if (!prev) {
      execByPlanItem.set(ei.sourceEntityId ?? "", {
        id: ei.id,
        status: ei.status,
      });
    } else {
      // Rank: completed > ready > running > scheduled > others
      const rank: Record<string, number> = {
        completed: 5,
        ready: 4,
        running: 3,
        scheduled: 2,
        authorized: 1,
      };
      if ((rank[ei.status] ?? 0) > (rank[prev.status] ?? 0)) {
        execByPlanItem.set(ei.sourceEntityId ?? "", {
          id: ei.id,
          status: ei.status,
        });
      }
    }
  }

  const pendingCount = items.filter((i) => i.status === "pending_approval")
    .length;
  const counts = items.reduce<Record<string, number>>((acc, it) => {
    acc[it.status] = (acc[it.status] ?? 0) + 1;
    return acc;
  }, {});

  const productOptions = products.map((p) => ({ id: p.id, name: p.name }));
  const accountOptions = accounts.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    platform: a.platform,
  }));

  return (
    <>
      <Topbar
        title="Weekly plan"
        description="Everything planned for this week. Edit, schedule, attach a creative, then approve once."
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
          <>
            {pendingCount > 0 && plan ? (
              <ApprovePlanForm
                planId={plan.id}
                pendingCount={pendingCount}
              />
            ) : null}
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
              <div className="px-5 py-2.5 border-b border-ink-100 flex flex-wrap gap-2 text-[10px]">
                {Object.entries(counts).map(([status, n]) => (
                  <span key={status} className={`${badgeClass(status)}`}>
                    {STATUS_LABELS[status] ?? status} · {n}
                  </span>
                ))}
              </div>
              <ul className="row-divider">
                {items.map((it) => {
                  const isPost = it.contentType === "post";
                  const creative = creativeByItem.get(it.id) ?? null;
                  const creativeReason = isPost
                    ? creativeReadinessReason(creative)
                    : null;
                  const warnings: string[] = [];
                  if (isPost && !it.scheduledAt) {
                    warnings.push(
                      "Missing schedule — set a date/time before approving.",
                    );
                  }
                  if (isPost && creativeReason) {
                    warnings.push(
                      `Creative not ready: ${creativeReason.replace(/_/g, " ")}.`,
                    );
                  }

                  const badge = creativeReadinessBadge(creative);
                  const creativeBadge = {
                    label: `creative · ${badge.replace("_", " ")}`,
                    cls:
                      badge === "approved"
                        ? "badge-low"
                        : badge === "rejected" || badge === "missing"
                          ? "badge-high"
                          : badge === "needs_review"
                            ? "badge-info"
                            : "badge-medium",
                  };

                  const exec = execByPlanItem.get(it.id) ?? null;
                  return (
                    <PlanItemRow
                      key={it.id}
                      id={it.id}
                      title={it.title}
                      body={it.body}
                      platform={it.platform}
                      contentType={it.contentType}
                      productId={it.productId}
                      accountId={it.accountId}
                      scheduledAt={it.scheduledAt}
                      status={it.status}
                      riskScore={it.riskScore}
                      riskLevel={it.riskLevel}
                      notes={
                        typeof it.metadata?.operator_notes === "string"
                          ? (it.metadata.operator_notes as string)
                          : null
                      }
                      statusLabel={STATUS_LABELS[it.status] ?? it.status}
                      statusBadgeClass={badgeClass(it.status)}
                      isPost={isPost}
                      warnings={warnings}
                      products={productOptions}
                      accounts={accountOptions}
                      executionItemId={exec?.id ?? null}
                      executionItemStatus={exec?.status ?? null}
                      creative={
                        creative
                          ? {
                              id: creative.id,
                              creativeType: creative.creativeType,
                              sourceType: creative.sourceType,
                              sourceUrl: creative.sourceUrl,
                              assetUrl: creative.assetUrl,
                              prompt: creative.prompt,
                              altText: creative.altText,
                              license: creative.license,
                              attribution: creative.attribution,
                              riskNotes: creative.riskNotes,
                              status: creative.status,
                            }
                          : null
                      }
                      creativeBadge={creativeBadge}
                    />
                  );
                })}
              </ul>
            </section>
          </>
        )}

        <CreateItemForm products={productOptions} accounts={accountOptions} />
      </div>
    </>
  );
}
