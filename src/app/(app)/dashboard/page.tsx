import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { LockIcon } from "@/components/icons";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { normalizeWorkspaceTimezone } from "@/core/scheduling/workspace-time";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import { summarizeAttentionItems } from "@/core/publishing/attention-summary";
import { isStaleClaim } from "@/core/publishing/execution-claim";
import {
  getCurrentWeeklyPlan,
  listUnfinishedItemsFromOlderPlans,
  listPlanItems,
  type WeeklyPlanItem,
} from "@/repositories/weekly-plan-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import {
  listCreativesForItems,
  creativeReadinessBadge,
} from "@/repositories/weekly-plan-creative-repository";
import {
  listExecutionItemsByPlanItemIds,
  listExecutionItemsByStatus,
} from "@/repositories/execution-item-repository";
import { listRecentActivity } from "@/repositories/activity-repository";
import {
  ActivityFeed,
  type ActivityFeedItem,
} from "@/components/dashboard/activity-feed";
import {
  summaryCounts,
  isAwaitingApprovalItem,
  isScheduledItem,
  compareOldestFirst,
  compareScheduledAsc,
  type WorkflowItemView,
  type SummaryCounts,
} from "@/core/dashboard/workflow-filters";
import { ExecutionStateBadge } from "@/components/publishing/execution-state";
import { readAllowedTestSubreddits } from "@/core/publishing/safe-test-env";
import { isRedditOauthBlocked } from "@/lib/oauth/env";
import {
  RecentlyPublishedStrip,
  type RecentlyPublishedEntry,
} from "@/components/publishing/recently-published-strip";
import {
  NeedsAttentionStrip,
  type NeedsAttentionEntry,
} from "@/components/publishing/needs-attention-strip";
import { NewPostButton } from "@/components/founder-compose/new-post-button";
import {
  formatUtcForOperatorDebug,
  formatUtcForWorkspace,
} from "@/core/scheduling/workspace-time";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <>
        <Topbar title="Welcome" description="Persistence not configured." />
        <div className="px-6 lg:px-10 py-12 max-w-3xl">
          <div className="rounded-2xl border border-ink-200 bg-white p-5 text-sm text-ink-600">
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
  const [products, accounts, plan, recentPublishes, connections, activityEvents] =
    await Promise.all([
      listProducts(workspaceId),
      listAccounts(workspaceId),
      getCurrentWeeklyPlan(workspaceId),
      listRecentPublishes(workspaceId, 30),
      listPlatformConnections(workspaceId),
      listRecentActivity(workspaceId, 12),
    ]);

  const items = plan ? await listPlanItems(workspaceId, plan.id) : [];

  // Welcome / empty state — no products, accounts, or items yet.
  const hasAnyData =
    products.length > 0 || accounts.length > 0 || items.length > 0;
  if (!hasAnyData) {
    const supabase = createSupabaseServerClient();
    const { data: wsSettings } = await supabase
      .from("workspace_settings")
      .select("timezone")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    // Phase F7.5 — validate workspace timezone at read time so an
    // invalid persisted value can't cascade into a render crash.
    const rawTimezone =
      (wsSettings as { timezone?: string | null } | null)?.timezone ?? null;
    const timezoneLabel =
      rawTimezone === null
        ? null
        : normalizeWorkspaceTimezone(rawTimezone) === "UTC" &&
            rawTimezone !== "UTC"
          ? null
          : rawTimezone;
    const allowedSubreddits = readAllowedTestSubreddits();
    const composeDefaults = {
      timezoneLabel,
      defaultAccountId: null,
      defaultProductId: null,
      defaultSubreddit: allowedSubreddits[0] ?? "test",
      accounts: [],
      products: [],
      allowedSubreddits,
    };
    return (
      <>
        <Topbar
          title="Welcome"
          description="A calm publishing workspace for solo founders."
        />
        <div className="px-4 sm:px-6 lg:px-10 py-12 max-w-2xl space-y-8">
          <section>
            <h2 className="text-base font-semibold text-ink-900">
              Start with one product, one account.
            </h2>
            <p className="text-sm text-ink-600 mt-2 leading-relaxed">
              Add the product you&apos;re publishing for, then connect the
              account you&apos;ll publish from. After that, every post stays
              in your hands — Signal never publishes without your approval.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link href="/products" className="btn-primary">
                Add a product
              </Link>
              <Link href="/accounts" className="btn">
                Connect an account
              </Link>
              <NewPostButton variant="inline" defaults={composeDefaults} />
            </div>
          </section>

          <section className="rounded-2xl border border-ink-200 bg-white p-4 flex items-start gap-3 text-sm">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
              <LockIcon />
            </span>
            <div>
              <div className="font-semibold text-ink-900">
                No passwords, ever.
              </div>
              <p className="text-ink-700 mt-0.5 leading-relaxed">
                Signal connects to platforms through their official OAuth
                flow — no passwords, no cookies, no session tokens.
              </p>
            </div>
          </section>
        </div>
      </>
    );
  }

  // ---- Compose defaults for the inline + FAB new-post buttons ----
  const supabase = createSupabaseServerClient();
  const { data: wsSettings } = await supabase
    .from("workspace_settings")
    .select("timezone")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  // Phase F7.5 — validate workspace timezone at read time so an
  // invalid persisted value can't cascade into a render crash. The
  // formatter helpers ALSO defend internally; this normalization
  // exists so the topbar / debug copy shows a clean label.
  const rawTimezoneTopLevel =
    (wsSettings as { timezone?: string | null } | null)?.timezone ?? null;
  const timezoneLabel =
    rawTimezoneTopLevel === null
      ? null
      : normalizeWorkspaceTimezone(rawTimezoneTopLevel) === "UTC" &&
          rawTimezoneTopLevel !== "UTC"
        ? null
        : rawTimezoneTopLevel;
  const allowedSubreddits = readAllowedTestSubreddits();
  const confirmedRedditAccounts = accounts.filter(
    (a) => a.platform === "reddit" && a.reviewStatus === "confirmed",
  );
  const confirmedProducts = products.filter(
    (p) => p.reviewStatus === "confirmed",
  );
  const composeDefaults = {
    timezoneLabel,
    defaultAccountId:
      confirmedRedditAccounts.length === 1
        ? confirmedRedditAccounts[0].id
        : null,
    defaultProductId:
      confirmedProducts.length === 1 ? confirmedProducts[0].id : null,
    defaultSubreddit: allowedSubreddits[0] ?? "test",
    accounts: accounts.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      platform: a.platform,
    })),
    products: products.map((p) => ({ id: p.id, name: p.name })),
    allowedSubreddits,
  };

  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;

  // ---- Creatives (thumbnails + the real creative-review signal) ----
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

  // ---- Workflow buckets — sliced from REAL weekly_plan_items.status ----
  // No derived/fake statuses: each bucket keys off the real status,
  // real risk_level, and the real creative-review badge.
  const itemById = new Map(items.map((it) => [it.id, it] as const));
  const workflowViews: WorkflowItemView[] = items.map((it) => ({
    id: it.id,
    status: it.status,
    riskLevel: it.riskLevel,
    scheduledAt: it.scheduledAt,
    effectiveAt: it.scheduledAt,
    createdAt: it.createdAt,
    needsCreativeReview:
      creativeReadinessBadge(creativeByItem.get(it.id) ?? null) ===
      "needs_review",
    hasFailure: false,
  }));
  const counts = summaryCounts(workflowViews);

  // Awaiting approval — oldest first (the operator action queue).
  const awaitingApprovalItems = workflowViews
    .filter(isAwaitingApprovalItem)
    .sort(compareOldestFirst)
    .map((v) => itemById.get(v.id))
    .filter((it): it is WeeklyPlanItem => Boolean(it));

  // Scheduled soon — nearest publish time first, next 20.
  const scheduledItems = workflowViews
    .filter(isScheduledItem)
    .sort(compareScheduledAsc)
    .map((v) => itemById.get(v.id))
    .filter((it): it is WeeklyPlanItem => Boolean(it));
  const scheduledSoon = scheduledItems.slice(0, 20);

  // Nothing scheduled for tomorrow? (calm cadence prompt).
  const tomorrowStart = startOfToday.getTime() + dayMs;
  const tomorrowEnd = tomorrowStart + dayMs;
  const nothingTomorrow = !scheduledItems.some((it) => {
    if (!it.scheduledAt) return false;
    const t = new Date(it.scheduledAt).getTime();
    return t >= tomorrowStart && t < tomorrowEnd;
  });

  // ---- Continue writing — drafts that still need finishing ----
  const drafts = items
    .filter((it) => it.status === "draft" || it.status === "skipped")
    .slice(0, 4);

  // ---- Needs attention (A4) — centralized through the pure
  // summarizeAttentionItems digest over REAL pipeline state:
  // terminal failures (with retry-exhausted flag), blocked items,
  // automatic retries in flight, STALE CLAIMS (publishes that started
  // but never finished — possible double-publish), expired
  // connections, and carry-over from previous weeks. Everything is
  // source-of-truth derived; no published/completed item can appear.
  const redditBlocked = isRedditOauthBlocked();
  const [
    failedExecItems,
    blockedExecItems,
    runningExecItems,
    retryingExecItems,
    olderUnfinished,
  ] = await Promise.all([
    listExecutionItemsByStatus(workspaceId, ["failed"], { limit: 10 }),
    listExecutionItemsByStatus(workspaceId, ["blocked"], { limit: 10 }),
    listExecutionItemsByStatus(workspaceId, ["running"], { limit: 20 }),
    listExecutionItemsByStatus(workspaceId, ["scheduled"], {
      limit: 20,
      minAttemptCount: 1,
    }),
    listUnfinishedItemsFromOlderPlans(workspaceId, plan?.id ?? null),
  ]);

  const metaStr = (m: Record<string, unknown>, path: string[]): string | null => {
    let cur: unknown = m;
    for (const k of path) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
      else return null;
    }
    return typeof cur === "string" ? cur : null;
  };
  const metaBool = (m: Record<string, unknown>, path: string[]): boolean => {
    let cur: unknown = m;
    for (const k of path) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[k];
      else return false;
    }
    return cur === true;
  };
  const platformLabelFor = (p: string | null): string =>
    p === "reddit"
      ? "Reddit"
      : p === "linkedin"
        ? "LinkedIn"
        : p === "x"
          ? "X"
          : p ?? "Platform";

  const attention = summarizeAttentionItems({
    failedPublishes: failedExecItems.map((it) => {
      const target = metaStr(it.metadata, ["target"]);
      return {
        id: it.id,
        where: target ? `r/${target}` : platformLabelFor(it.platform),
        executionItemId: it.id,
        retryExhausted: metaBool(it.metadata, ["retry", "exhausted"]),
      };
    }),
    blockedItems: blockedExecItems.map((it) => ({
      id: it.id,
      title: it.title,
      reasonCode: metaStr(it.metadata, ["publish_outcome", "reason_code"]),
      executionItemId: it.id,
    })),
    retryingItems: retryingExecItems
      .filter((it) => metaStr(it.metadata, ["retry", "next_retry_at"]) !== null)
      .map((it) => ({
        id: it.id,
        title: it.title,
        nextRetryAtIso: metaStr(it.metadata, ["retry", "next_retry_at"]),
        attemptCount: it.attemptCount,
        maxAttempts: it.maxAttempts,
      })),
    staleClaims: runningExecItems
      .filter((it) =>
        isStaleClaim(metaStr(it.metadata, ["scheduler_claim", "claimed_at"]), now),
      )
      .map((it) => ({
        id: it.id,
        title: it.title,
        claimedAtIso: metaStr(it.metadata, ["scheduler_claim", "claimed_at"]),
      })),
    expiredConnections: connections
      .filter(
        (c) =>
          c.accountId &&
          (c.connectionStatus === "expired" ||
            c.connectionStatus === "reauthorization_required" ||
            c.healthStatus === "expired" ||
            c.healthStatus === "revoked"),
      )
      .map((c) => ({ id: c.id, platformLabel: platformLabelFor(c.platform) })),
    carryOverCount: olderUnfinished.length,
  });

  const needsAttention: NeedsAttentionEntry[] = [...attention.entries];
  // Soft prompts that aren't failures (kept as low-priority info).
  const pendingApproval = items.filter((it) => it.status === "pending_approval");
  if (pendingApproval.length > 0) {
    needsAttention.push({
      id: "pending-approval",
      message: `${pendingApproval.length} post${
        pendingApproval.length === 1 ? "" : "s"
      } waiting for your approval.`,
      href: "/weekly-plan?tab=queue",
      cta: "Review",
      severity: "info",
    });
  }
  if (redditBlocked) {
    needsAttention.push({
      id: "reddit-blocker",
      message:
        "Reddit publishing is currently manual while their API approval is pending. Drafts still flow normally.",
      href: "/accounts",
      cta: "About",
      severity: "info",
    });
  }

  // ---- Recent activity — most recent successful publishes (last 20) ----
  const planItemByExecItem = new Map<string, string>();
  const execItems = items.length
    ? await listExecutionItemsByPlanItemIds(
        workspaceId,
        items.map((i) => i.id),
      )
    : [];
  for (const ei of execItems) {
    if (ei.sourceEntityId) planItemByExecItem.set(ei.id, ei.sourceEntityId);
  }
  const titleByPlanItem = new Map<string, string | null>();
  for (const it of items) titleByPlanItem.set(it.id, it.title);
  const recentlyPublished: RecentlyPublishedEntry[] = recentPublishes
    .filter((p) => p.outcome === "published")
    .slice(0, 20)
    .map((p) => {
      const planItemId = planItemByExecItem.get(p.executionItemId) ?? null;
      const creative = planItemId
        ? creativeByItem.get(planItemId) ?? null
        : null;
      return {
        id: p.id,
        title: planItemId ? titleByPlanItem.get(planItemId) ?? null : null,
        platform: p.platform,
        subreddit: p.subreddit,
        permalink: p.providerPermalink,
        publishedAt: p.finishedAt,
        creativeAssetUrl: creative?.assetUrl ?? null,
      };
    });

  // ---- Publishing cadence — calm "this week" rhythm line ----
  const successfulPublishes = recentPublishes.filter(
    (p) => p.outcome === "published",
  );
  const sevenDaysAgo = Date.now() - 7 * dayMs;
  const publishesThisWeek = successfulPublishes.filter(
    (p) => new Date(p.finishedAt).getTime() >= sevenDaysAgo,
  ).length;
  const lastPublish = successfulPublishes[0]?.finishedAt ?? null;
  const lastPublishAgeDays = lastPublish
    ? Math.floor((Date.now() - new Date(lastPublish).getTime()) / dayMs)
    : null;
  const cadenceLine = buildCadenceLine({
    publishesThisWeek,
    lastPublishAgeDays,
    draftsCount: drafts.length,
    nothingTomorrow,
  });

  // Compact activity-feed rows from the existing activity_events audit.
  const activityFeed: ActivityFeedItem[] = activityEvents.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    title: e.title,
    metadata: e.metadata,
    createdAt: e.createdAt,
  }));

  return (
    <>
      <Topbar
        title="This week"
        description="Your publishing week at a glance."
        actions={
          <div className="flex items-center gap-2">
            <NewPostButton
              variant="inline"
              className="hidden md:inline-flex"
              defaults={composeDefaults}
            />
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
        {cadenceLine ? (
          <p className="text-xs text-ink-500 leading-relaxed">
            {cadenceLine}
          </p>
        ) : null}

        {/* Needs attention — only when there's something to attend to */}
        <NeedsAttentionStrip entries={needsAttention} />

        {/* Summary cards — direct counts of the real plan statuses */}
        <SummaryCards counts={counts} />

        {/* Awaiting approval — work requiring action, oldest first */}
        <AwaitingApprovalSection items={awaitingApprovalItems} />

        {/* Scheduled soon — next 20, nearest publish time first */}
        <ScheduledSoonSection
          posts={scheduledSoon}
          total={scheduledItems.length}
          timezone={timezoneLabel ?? "UTC"}
        />

        {/* Recent activity — recently published (last 20) */}
        {recentlyPublished.length > 0 ? (
          <div className="space-y-1.5">
            <RecentlyPublishedStrip entries={recentlyPublished} />
            <div className="text-right">
              <Link
                href="/weekly-plan?tab=published"
                className="text-xs font-medium text-signal-700 hover:text-signal-800"
              >
                View all published →
              </Link>
            </div>
          </div>
        ) : null}

        {/* Operator activity feed — from the existing audit events */}
        <ActivityFeed events={activityFeed} />

        {/* Quick capture */}
        {drafts.length > 0 ? (
          <section className="rounded-2xl border border-ink-200 bg-white p-5 space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-ink-900">
                Continue writing
              </h2>
              <Link
                href="/weekly-plan"
                className="text-xs text-signal-700 hover:text-signal-800"
              >
                See all drafts →
              </Link>
            </div>
            <ul className="space-y-2">
              {drafts.map((d) => (
                <li key={d.id}>
                  <Link
                    href="/weekly-plan"
                    className="block rounded-md border border-ink-200 bg-white px-3 py-2.5 hover:bg-ink-50"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-sm font-medium text-ink-900 truncate min-w-0 flex-1">
                        {d.title?.trim() || "Untitled draft"}
                      </div>
                      <div className="text-[10px] text-ink-500 shrink-0">
                        {formatLastEdited(d.updatedAt)}
                      </div>
                    </div>
                    {d.body ? (
                      <p className="text-xs text-ink-600 mt-0.5 line-clamp-2 leading-relaxed">
                        {d.body}
                      </p>
                    ) : (
                      <p className="text-xs text-ink-400 italic mt-0.5">
                        No body yet — tap to keep writing.
                      </p>
                    )}
                    {d.scheduledAt ? (
                      <div className="text-[11px] text-ink-500 mt-1">
                        Scheduled for{" "}
                        {
                          formatUtcForWorkspace(
                            d.scheduledAt as string,
                            timezoneLabel ?? "UTC",
                          ).local
                        }{" "}
                        ({timezoneLabel ?? "UTC"}) ·{" "}
                        {formatUtcForOperatorDebug(d.scheduledAt as string)}
                      </div>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </>
  );
}

/**
 * Summary cards — direct counts of the REAL weekly_plan_items.status
 * (Awaiting approval / Scheduled / Published / Paused). Each card links
 * to its focused Weekly Plan tab. No derived arithmetic.
 */
function SummaryCards({ counts }: { counts: SummaryCounts }) {
  const cards: {
    label: string;
    value: number;
    href: string;
    valueClass: string;
  }[] = [
    {
      label: "Awaiting approval",
      value: counts.awaitingApproval,
      href: "/weekly-plan?tab=queue",
      valueClass: "text-amber-700",
    },
    {
      label: "Scheduled",
      value: counts.scheduled,
      href: "/weekly-plan?tab=scheduled",
      valueClass: "text-signal-700",
    },
    {
      label: "Published",
      value: counts.published,
      href: "/weekly-plan?tab=published",
      valueClass: "text-emerald-700",
    },
    {
      label: "Paused",
      value: counts.paused,
      href: "/weekly-plan?tab=paused",
      valueClass: "text-ink-500",
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {cards.map((c) => (
        <Link
          key={c.label}
          href={c.href}
          className="card p-4 hover:bg-ink-50/60 transition-colors focus:outline-none focus:ring-2 focus:ring-signal-300 focus:ring-offset-1"
        >
          <div className={`text-2xl font-semibold tabular-nums ${c.valueClass}`}>
            {c.value}
          </div>
          <div className="stat-label mt-0.5">{c.label}</div>
        </Link>
      ))}
    </div>
  );
}

/**
 * Awaiting approval — the operator action list, oldest first. Shows up
 * to 6 rows with a "+N more" affordance into the Queue tab. Renders a
 * calm "all caught up" line when empty so the dashboard never shows a
 * hollow card.
 */
function AwaitingApprovalSection({ items }: { items: WeeklyPlanItem[] }) {
  const MAX = 6;
  const shown = items.slice(0, MAX);
  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink-900">Awaiting approval</h2>
        {items.length > 0 ? (
          <Link
            href="/weekly-plan?tab=queue"
            className="text-xs font-medium text-signal-700 hover:text-signal-800"
          >
            Open queue →
          </Link>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-ink-500">
          All caught up — nothing waiting for your approval.
        </p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {shown.map((it) => (
              <li key={it.id}>
                <Link
                  href="/weekly-plan?tab=queue"
                  className="flex items-center justify-between gap-3 rounded-md border border-ink-200 bg-white px-3 py-2 hover:bg-ink-50"
                >
                  <span className="min-w-0 flex-1 flex items-center gap-2">
                    <ExecutionStateBadge status={it.status} />
                    <span className="text-sm text-ink-800 truncate">
                      {it.title?.trim() || "Untitled post"}
                    </span>
                  </span>
                  <span className="text-[10px] text-ink-400 shrink-0">
                    {formatLastEdited(it.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {items.length > MAX ? (
            <Link
              href="/weekly-plan?tab=queue"
              className="text-xs font-medium text-signal-700 hover:text-signal-800"
            >
              + {items.length - MAX} more in the queue →
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Scheduled soon — the next 20 scheduled posts, nearest publish time
 * first, with a "View all scheduled" link into the Scheduled tab.
 */
function ScheduledSoonSection({
  posts,
  total,
  timezone,
}: {
  posts: WeeklyPlanItem[];
  total: number;
  timezone: string;
}) {
  return (
    <section className="card p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink-900">Scheduled soon</h2>
        {total > 0 ? (
          <Link
            href="/weekly-plan?tab=scheduled"
            className="text-xs font-medium text-signal-700 hover:text-signal-800"
          >
            View all scheduled →
          </Link>
        ) : null}
      </div>
      {posts.length === 0 ? (
        <p className="text-sm text-ink-500">Nothing scheduled yet.</p>
      ) : (
        <>
          <ul className="space-y-1.5">
            {posts.map((p) => (
              <li
                key={p.id}
                className="flex items-baseline justify-between gap-3 text-xs"
              >
                <Link
                  href="/weekly-plan?tab=scheduled"
                  className="text-ink-800 truncate hover:text-signal-700 min-w-0 flex-1"
                >
                  {p.title?.trim() || "Untitled post"}
                </Link>
                <span
                  className="text-[11px] text-ink-500 shrink-0"
                  title={
                    p.scheduledAt
                      ? `${formatUtcForOperatorDebug(p.scheduledAt as string)} · ${timezone}`
                      : undefined
                  }
                >
                  {p.scheduledAt
                    ? formatUtcForWorkspace(p.scheduledAt as string, timezone).local
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
          {total > posts.length ? (
            <Link
              href="/weekly-plan?tab=scheduled"
              className="text-xs font-medium text-signal-700 hover:text-signal-800"
            >
              + {total - posts.length} more scheduled →
            </Link>
          ) : null}
        </>
      )}
    </section>
  );
}

function formatLastEdited(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "";
  const minutes = ms / 60000;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function buildCadenceLine(input: {
  publishesThisWeek: number;
  lastPublishAgeDays: number | null;
  draftsCount: number;
  nothingTomorrow: boolean;
}): string | null {
  const parts: string[] = [];

  if (input.publishesThisWeek > 0) {
    parts.push(
      `You've published ${input.publishesThisWeek} time${
        input.publishesThisWeek === 1 ? "" : "s"
      } this week.`,
    );
  } else if (input.lastPublishAgeDays === null) {
    parts.push("Nothing published yet.");
  } else if (input.lastPublishAgeDays === 0) {
    parts.push("Last publish was earlier today.");
  } else if (input.lastPublishAgeDays === 1) {
    parts.push("Last publish was yesterday.");
  } else {
    parts.push(`Last publish was ${input.lastPublishAgeDays} days ago.`);
  }

  if (input.nothingTomorrow && input.draftsCount > 0) {
    parts.push(
      `${input.draftsCount} draft${
        input.draftsCount === 1 ? " is" : "s are"
      } waiting to be finished.`,
    );
  }

  if (parts.length === 0) return null;
  return parts.join(" ");
}
