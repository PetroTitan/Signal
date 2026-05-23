import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import {
  getCurrentWeeklyPlan,
  listPlanItems,
} from "@/repositories/weekly-plan-repository";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import {
  creativeReadinessReason,
  listCreativesForItems,
} from "@/repositories/weekly-plan-creative-repository";
import { listExecutionItemsByPlanItemIds } from "@/repositories/execution-item-repository";
import { CreateItemForm } from "./_create-item-form";
import { ApprovePlanForm } from "./_approve-plan-form";
import { PlanItemCard } from "./_plan-item-card";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { readAllowedTestSubreddits } from "@/core/publishing/safe-test-env";

export const dynamic = "force-dynamic";

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
  const supabase = createSupabaseServerClient();
  const { data: wsSettings } = await supabase
    .from("workspace_settings")
    .select("timezone")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const timezoneLabel =
    (wsSettings as { timezone?: string | null } | null)?.timezone ?? null;

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

  const execItems = items.length
    ? await listExecutionItemsByPlanItemIds(
        workspaceId,
        items.map((i) => i.id),
      )
    : [];
  const execByPlanItem = new Map<string, { id: string; status: string }>();
  for (const ei of execItems) {
    const key = ei.sourceEntityId ?? "";
    const prev = execByPlanItem.get(key);
    if (!prev) {
      execByPlanItem.set(key, { id: ei.id, status: ei.status });
    } else {
      const rank: Record<string, number> = {
        completed: 6,
        ready_for_manual_publish: 5,
        ready: 4,
        running: 3,
        scheduled: 2,
        authorized: 1,
      };
      if ((rank[ei.status] ?? 0) > (rank[prev.status] ?? 0)) {
        execByPlanItem.set(key, { id: ei.id, status: ei.status });
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
  const allowedSubreddits = readAllowedTestSubreddits();

  // ---- Day grouping ----
  const groups = groupByDay(items);

  return (
    <>
      <Topbar
        title="Weekly plan"
        description={
          timezoneLabel
            ? `Everything planned for this week. All times shown in ${timezoneLabel}.`
            : "Everything planned for this week. All times shown in your browser timezone."
        }
        actions={
          plan ? (
            <Link href="/approval-queue" className="btn-primary">
              Open approval queue
            </Link>
          ) : null
        }
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
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
              Week of {plan.weekStart}. No items yet — add one below.
            </p>
          </section>
        ) : (
          <>
            {pendingCount > 0 ? (
              <ApprovePlanForm
                planId={plan.id}
                pendingCount={pendingCount}
              />
            ) : null}

            {/* Lightweight progress strip — no card, no border noise */}
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-ink-500">
                {items.length} item{items.length === 1 ? "" : "s"} this week:
              </span>
              {Object.entries(counts).map(([status, n]) => (
                <span
                  key={status}
                  className="inline-flex items-center gap-1.5"
                >
                  <ExecutionStateBadge
                    status={status as Parameters<typeof ExecutionStateBadge>[0]["status"]}
                  />
                  <span className="text-ink-500">{n}</span>
                </span>
              ))}
            </div>

            {/* Day-grouped cards */}
            <div className="space-y-6">
              {groups.map((group) => (
                <section key={group.key} className="space-y-2">
                  <DayHeader group={group} />
                  <div className="space-y-2">
                    {group.items.map((it) => {
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
                      const exec = execByPlanItem.get(it.id) ?? null;
                      const subreddit =
                        typeof it.metadata?.target === "string"
                          ? (it.metadata.target as string)
                          : null;
                      const notes =
                        typeof it.metadata?.operator_notes === "string"
                          ? (it.metadata.operator_notes as string)
                          : null;
                      return (
                        <PlanItemCard
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
                          notes={notes}
                          isPost={isPost}
                          warnings={warnings}
                          timezoneLabel={timezoneLabel}
                          subreddit={subreddit}
                          products={productOptions}
                          accounts={accountOptions}
                          allowedSubreddits={allowedSubreddits}
                          executionItemId={exec?.id ?? null}
                          executionItemStatus={exec?.status ?? null}
                          creative={
                            creative
                              ? {
                                  id: creative.id,
                                  creativeType: creative.creativeType,
                                  sourceType: creative.sourceType,
                                  status: creative.status,
                                  assetUrl: creative.assetUrl,
                                  sourceUrl: creative.sourceUrl,
                                  altText: creative.altText,
                                  license: creative.license,
                                  attribution: creative.attribution,
                                  prompt: creative.prompt,
                                  mimeType: creative.mimeType,
                                  sizeBytes: creative.sizeBytes,
                                  uploadedAt: creative.uploadedAt,
                                }
                              : null
                          }
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        <CreateItemForm products={productOptions} accounts={accountOptions} />
      </div>
    </>
  );
}

// =====================================================================
// Day-grouping helpers
// =====================================================================

interface DayGroup {
  /** Sort key — YYYY-MM-DD for scheduled days, "9999" for unscheduled. */
  key: string;
  /** ISO date or `null` for the unscheduled bucket. */
  isoDate: string | null;
  /** Founder-readable label, e.g. "Mon, May 26". */
  label: string;
  items: Awaited<ReturnType<typeof listPlanItems>>;
}

function groupByDay(
  items: Awaited<ReturnType<typeof listPlanItems>>,
): DayGroup[] {
  const byKey = new Map<string, DayGroup>();
  for (const it of items) {
    if (it.scheduledAt) {
      const d = new Date(it.scheduledAt);
      if (Number.isNaN(d.getTime())) {
        // Treat unparseable as unscheduled.
        ensureGroup(byKey, "9999-99-99", null, "Unscheduled").items.push(it);
        continue;
      }
      const isoDate = toIsoDate(d);
      const label = d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      ensureGroup(byKey, isoDate, d.toISOString(), label).items.push(it);
    } else {
      ensureGroup(byKey, "9999-99-99", null, "Unscheduled").items.push(it);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function ensureGroup(
  m: Map<string, DayGroup>,
  key: string,
  isoDate: string | null,
  label: string,
): DayGroup {
  let g = m.get(key);
  if (!g) {
    g = { key, isoDate, label, items: [] };
    m.set(key, g);
  }
  return g;
}

function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function DayHeader({ group }: { group: DayGroup }) {
  const isUnscheduled = group.isoDate === null;
  return (
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide">
      <div
        className={`px-2 py-0.5 rounded-md ${
          isUnscheduled
            ? "bg-amber-50 text-amber-700 border border-amber-100"
            : "bg-ink-100 text-ink-700"
        } font-semibold`}
      >
        {group.label}
      </div>
      <span className="text-ink-400">
        {group.items.length} item{group.items.length === 1 ? "" : "s"}
      </span>
    </div>
  );
}
