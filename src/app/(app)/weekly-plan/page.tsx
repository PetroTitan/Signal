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
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { isRedditOauthBlocked } from "@/lib/oauth/env";
import { ApprovePlanForm } from "./_approve-plan-form";
import { PlanItemCard } from "./_plan-item-card";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { readAllowedTestSubreddits } from "@/core/publishing/safe-test-env";
import { readGenerationProviderStatus } from "@/core/generation/provider-status";
import { NewPostButton } from "@/components/founder-compose/new-post-button";
import {
  ContinueWritingStrip,
  type ContinueWritingDraft,
} from "./_continue-writing";
import {
  RecentlyPublishedStrip,
  type RecentlyPublishedEntry,
} from "@/components/publishing/recently-published-strip";
import {
  NeedsAttentionStrip,
  type NeedsAttentionEntry,
} from "@/components/publishing/needs-attention-strip";

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

  const [plan, products, accounts, recentPublishes, connections] =
    await Promise.all([
      getCurrentWeeklyPlan(workspaceId),
      listProducts(workspaceId),
      listAccounts(workspaceId),
      listRecentPublishes(workspaceId, 30),
      listPlatformConnections(workspaceId),
    ]);
  const redditBlocked = isRedditOauthBlocked();

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

  // Smart defaults for the founder compose sheet.
  const confirmedRedditAccounts = accounts.filter(
    (a) => a.platform === "reddit" && a.reviewStatus === "confirmed",
  );
  const confirmedProducts = products.filter(
    (p) => p.reviewStatus === "confirmed",
  );
  const aiProviderStatus = readGenerationProviderStatus();
  const composeDefaults = {
    timezoneLabel,
    defaultAccountId:
      confirmedRedditAccounts.length === 1
        ? confirmedRedditAccounts[0].id
        : null,
    defaultProductId:
      confirmedProducts.length === 1 ? confirmedProducts[0].id : null,
    defaultSubreddit: allowedSubreddits[0] ?? "test",
    accounts: accountOptions,
    products: productOptions,
    allowedSubreddits,
    aiProviderAvailable: aiProviderStatus.available,
  };

  // ---- Day grouping ----
  const groups = groupByDay(items);

  // ---- Recently published (last 5 successful) ----
  const subredditByItem = new Map<string, string | null>();
  for (const it of items) {
    const sub =
      typeof it.metadata?.target === "string"
        ? (it.metadata.target as string)
        : null;
    subredditByItem.set(it.id, sub);
  }
  const planItemByExecItem = new Map<string, string>();
  for (const ei of execItems) {
    if (ei.sourceEntityId) planItemByExecItem.set(ei.id, ei.sourceEntityId);
  }
  const recentlyPublished: RecentlyPublishedEntry[] = recentPublishes
    .filter((p) => p.outcome === "published")
    .slice(0, 5)
    .map((p) => {
      const planItemId = planItemByExecItem.get(p.executionItemId) ?? null;
      const creative = planItemId ? creativeByItem.get(planItemId) ?? null : null;
      return {
        id: p.id,
        title: null,
        platform: p.platform,
        subreddit: p.subreddit,
        permalink: p.providerPermalink,
        publishedAt: p.finishedAt,
        creativeAssetUrl: creative?.assetUrl ?? null,
      };
    });
  // Title resolves from plan item when available.
  const titleByPlanItem = new Map<string, string | null>();
  for (const it of items) titleByPlanItem.set(it.id, it.title);
  for (const e of recentlyPublished) {
    // Re-find the plan item from the publish entry's execution item.
    const ph = recentPublishes.find((p) => p.id === e.id);
    if (!ph) continue;
    const pid = planItemByExecItem.get(ph.executionItemId);
    if (pid) e.title = titleByPlanItem.get(pid) ?? null;
  }

  // ---- Needs attention (calm founder inbox) ----
  const needsAttention: NeedsAttentionEntry[] = [];
  // 1. Recent failures (last 7 days).
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const p of recentPublishes) {
    if (p.outcome !== "failed") continue;
    if (new Date(p.finishedAt).getTime() < weekAgo) continue;
    const where = p.subreddit ? `r/${p.subreddit}` : p.platform;
    needsAttention.push({
      id: `fail-${p.id}`,
      message: `A post to ${where} didn't publish. Open it to see what happened.`,
      href: `/execution/items/${p.executionItemId}`,
      cta: "Open post",
      severity: "danger",
    });
    if (needsAttention.length >= 5) break;
  }
  // 2. Disconnected / expired connections.
  for (const c of connections) {
    if (!c.accountId) continue;
    if (
      c.connectionStatus === "expired" ||
      c.connectionStatus === "reauthorization_required" ||
      c.healthStatus === "expired" ||
      c.healthStatus === "revoked"
    ) {
      const platformLabel =
        c.platform === "reddit"
          ? "Reddit"
          : c.platform === "linkedin"
            ? "LinkedIn"
            : c.platform === "x"
              ? "X"
              : c.platform;
      needsAttention.push({
        id: `conn-${c.id}`,
        message: `${platformLabel} connection expired. Reconnect to keep publishing.`,
        href: "/accounts",
        cta: `Reconnect ${platformLabel}`,
        severity: "warn",
      });
      if (needsAttention.length >= 5) break;
    }
  }
  // 3. Reddit API approval (informational, low priority — only if no other
  // higher-priority items already filling the strip).
  if (redditBlocked && needsAttention.length < 5) {
    needsAttention.push({
      id: "reddit-blocker",
      message:
        "Reddit publishing is currently manual while their API approval is pending. Drafts still flow normally — you publish from the post preview.",
      href: "/accounts",
      cta: "About",
      severity: "info",
    });
  }

  // ---- Drafts that need attention ----
  const continueWritingDrafts: ContinueWritingDraft[] = items
    .filter((it) => it.status === "draft" || it.status === "skipped")
    .map((it) => {
      const creative = creativeByItem.get(it.id) ?? null;
      const missingParts: string[] = [];
      if (!it.title || it.title.trim().length === 0)
        missingParts.push("title");
      if (!it.body || it.body.trim().length === 0)
        missingParts.push("body");
      if (it.contentType === "post" && !it.scheduledAt)
        missingParts.push("schedule");
      if (
        it.contentType === "post" &&
        (!creative ||
          (!creative.assetUrl && !creative.sourceUrl) ||
          creative.status !== "approved")
      ) {
        missingParts.push("creative");
      }
      return { it, creative, missingParts };
    })
    .filter((entry) => entry.missingParts.length > 0)
    .slice(0, 5)
    .map(({ it, creative, missingParts }) => ({
      itemId: it.id,
      title: it.title,
      missing: missingParts.join(", "),
      existing: {
        itemId: it.id,
        title: it.title,
        body: it.body,
        platform: it.platform,
        contentType: it.contentType,
        subreddit:
          typeof it.metadata?.target === "string"
            ? (it.metadata.target as string)
            : null,
        accountId: it.accountId,
        productId: it.productId,
        scheduledAtIso: it.scheduledAt,
        riskScore: it.riskScore,
        notes:
          typeof it.metadata?.operator_notes === "string"
            ? (it.metadata.operator_notes as string)
            : null,
        creative: creative
          ? {
              id: creative.id,
              assetUrl: creative.assetUrl,
              altText: creative.altText,
              sourceType: creative.sourceType,
            }
          : null,
      },
    }));

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
          <div className="flex items-center gap-2">
            <NewPostButton
              variant="inline"
              className="hidden md:inline-flex"
              defaults={composeDefaults}
            />
            {null}
          </div>
        }
      />
      {/* Mobile FAB */}
      <NewPostButton
        variant="fab"
        className="md:hidden"
        defaults={composeDefaults}
      />
      <div className="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-3xl space-y-5">
        <NeedsAttentionStrip entries={needsAttention} />
        <RecentlyPublishedStrip entries={recentlyPublished} />
        {!plan || items.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-ink-300 bg-ink-50/40 p-8 text-center">
            <h2 className="text-base font-semibold text-ink-900">
              {plan ? plan.title : "No posts yet"}
            </h2>
            <p className="text-sm text-ink-500 mt-2 leading-relaxed max-w-md mx-auto">
              Have an idea? Capture it now — title and body are all you
              need to start. Schedule and creative can come later.
            </p>
            <div className="mt-4 flex justify-center">
              <NewPostButton variant="inline" defaults={composeDefaults} />
            </div>
          </section>
        ) : (
          <>
            {pendingCount > 0 ? (
              <ApprovePlanForm
                planId={plan.id}
                pendingCount={pendingCount}
              />
            ) : null}

            {continueWritingDrafts.length > 0 ? (
              <ContinueWritingStrip
                drafts={continueWritingDrafts}
                defaults={composeDefaults}
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
                <section key={group.bucket} className="space-y-2">
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
      </div>
    </>
  );
}

// =====================================================================
// Day-grouping helpers
// =====================================================================

type BucketId = "today" | "tomorrow" | "this_week" | "next_week" | "later" | "unscheduled";

interface DayGroup {
  bucket: BucketId;
  /** Sort key — lower-is-earlier; unscheduled always last. */
  sortKey: number;
  /** Founder-readable group title ("Today", "Tomorrow", …). */
  label: string;
  /** Optional sublabel: the specific date for Today/Tomorrow. */
  sublabel: string | null;
  items: Awaited<ReturnType<typeof listPlanItems>>;
}

const BUCKET_ORDER: Record<BucketId, number> = {
  today: 0,
  tomorrow: 1,
  this_week: 2,
  next_week: 3,
  later: 4,
  unscheduled: 5,
};

function bucketize(scheduledAt: string | null, now: Date): BucketId {
  if (!scheduledAt) return "unscheduled";
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return "unscheduled";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const dayDelta = Math.floor(
    (d.getTime() - startOfToday.getTime()) / dayMs,
  );
  if (dayDelta <= 0) return "today";
  if (dayDelta === 1) return "tomorrow";
  // Days to next Monday (the start of next week).
  const todayDow = startOfToday.getDay(); // 0=Sun..6=Sat
  const daysUntilNextMonday = ((1 + 7 - todayDow) % 7) || 7;
  const daysUntilWeekAfter = daysUntilNextMonday + 7;
  if (dayDelta < daysUntilNextMonday) return "this_week";
  if (dayDelta < daysUntilWeekAfter) return "next_week";
  return "later";
}

function groupByDay(
  items: Awaited<ReturnType<typeof listPlanItems>>,
): DayGroup[] {
  const now = new Date();
  const groups: Record<BucketId, DayGroup> = {
    today: makeGroup("today", "Today", labelForToday(now)),
    tomorrow: makeGroup("tomorrow", "Tomorrow", labelForTomorrow(now)),
    this_week: makeGroup("this_week", "Later this week", null),
    next_week: makeGroup("next_week", "Next week", null),
    later: makeGroup("later", "Later", null),
    unscheduled: makeGroup("unscheduled", "Unscheduled", null),
  };
  for (const it of items) {
    groups[bucketize(it.scheduledAt, now)].items.push(it);
  }
  // Sort items inside each bucket by scheduled time.
  for (const g of Object.values(groups)) {
    g.items.sort((a, b) => {
      const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity;
      const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity;
      return ta - tb;
    });
  }
  // F2.9: always render Today and Tomorrow even when empty — they're
  // the anchor points the operator scans for. Other buckets only
  // surface when they have items.
  return Object.values(groups)
    .filter((g) => {
      if (g.bucket === "today" || g.bucket === "tomorrow") return true;
      return g.items.length > 0;
    })
    .sort((a, b) => a.sortKey - b.sortKey);
}

function makeGroup(
  bucket: BucketId,
  label: string,
  sublabel: string | null,
): DayGroup {
  return {
    bucket,
    sortKey: BUCKET_ORDER[bucket],
    label,
    sublabel,
    items: [],
  };
}

function labelForToday(now: Date): string {
  return now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function labelForTomorrow(now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function DayHeader({ group }: { group: DayGroup }) {
  const accent =
    group.bucket === "today"
      ? "bg-signal-50 text-signal-700 border-signal-100"
      : group.bucket === "tomorrow"
        ? "bg-emerald-50 text-emerald-700 border-emerald-100"
        : group.bucket === "unscheduled"
          ? "bg-amber-50 text-amber-700 border-amber-100"
          : "bg-ink-100 text-ink-700 border-ink-200";
  const empty = group.items.length === 0;
  return (
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide">
      <div className={`px-2 py-0.5 rounded-md border font-semibold ${accent}`}>
        {group.label}
      </div>
      {group.sublabel ? (
        <span className="text-ink-500 normal-case tracking-normal">
          {group.sublabel}
        </span>
      ) : null}
      <span className="text-ink-400 normal-case tracking-normal">
        {empty
          ? "Nothing scheduled."
          : `${group.items.length} post${group.items.length === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
