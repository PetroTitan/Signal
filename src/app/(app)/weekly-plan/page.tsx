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
import { selectPrimaryCreativeByItem } from "./_primary-creative-selector";
import { getActiveContract } from "@/repositories/weekly-contract-repository";
import { listExecutionItemsByPlanItemIds } from "@/repositories/execution-item-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { isRedditOauthBlocked } from "@/lib/oauth/env";
import { ApprovePlanForm } from "./_approve-plan-form";
import { PlanItemCard } from "./_plan-item-card";
import { isApprovablePublishObject } from "@/core/platform-native/approval-policy";
import { parsePlatformNativeShape } from "@/core/platform-native";
import type { PublishPlatform } from "@/core/publishing/publishing-types";
import {
  computeContinueWritingMissingParts,
  computePlanItemWarnings,
} from "./_plan-item-warnings";
import {
  normalizeWorkspaceTimezone,
  validateWorkspaceTimezone,
} from "@/core/scheduling/workspace-time";
import { FocusOnMount } from "./_focus-on-mount";
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
import { deriveAiAssistedKind } from "@/components/publishing/ai-assisted-chip";
import { ACTIVE_EXECUTION_STATUSES } from "@/core/scheduling/effective-publish-schedule";
import {
  formatScheduleDisplay,
  type ScheduleDisplay,
} from "@/core/scheduling/format-schedule-display";

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
  // Phase F7.5 — validate the persisted timezone. A bad legacy
  // value (operator typed "Eastern Time" before the settings
  // validator landed) MUST NOT crash the page. We surface a
  // friendly "UTC" label in that case; the formatter helpers
  // ALSO defend internally via normalizeWorkspaceTimezone so the
  // Intl call site can never throw at render.
  const rawTimezone =
    (wsSettings as { timezone?: string | null } | null)?.timezone ?? null;
  const tzValidation = validateWorkspaceTimezone(rawTimezone);
  const timezoneLabel = tzValidation.ok ? tzValidation.value : null;

  const [plan, products, accounts, recentPublishes, connections, activeContract] =
    await Promise.all([
      getCurrentWeeklyPlan(workspaceId),
      listProducts(workspaceId),
      listAccounts(workspaceId),
      listRecentPublishes(workspaceId, 30),
      listPlatformConnections(workspaceId),
      getActiveContract(workspaceId),
    ]);
  const redditBlocked = isRedditOauthBlocked();
  const hasActiveContract = activeContract !== null;

  const items = plan ? await listPlanItems(workspaceId, plan.id) : [];

  const creatives = items.length
    ? await listCreativesForItems(
        workspaceId,
        items.map((i) => i.id),
      )
    : [];
  // UI / MCP parity: pick the primary creative per plan_item using
  // the SAME asset-aware selector that `signal.weekly_plan.current`
  // uses. Pre-fix this loop was "first row wins", which surfaced
  // older legacy / placeholder creatives even after a real upload
  // landed — diverging from MCP. See `_primary-creative-selector.ts`.
  const creativeByItem = selectPrimaryCreativeByItem(creatives);

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

  // Active execution_item per plan_item — separate from the chrome
  // rank above. This map only contains pending_authorization /
  // authorized / scheduled rows, i.e. those whose scheduled_at the
  // scheduler will actually fire on. The canonical schedule helper
  // uses this map; terminal / runner-claimed / retry rows fall back
  // to the editorial time on the plan_item.
  const activeExecByPlanItem = new Map<
    string,
    { id: string; status: string; scheduledAt: string | null }
  >();
  for (const ei of execItems) {
    if (!ei.sourceEntityId) continue;
    if (!ACTIVE_EXECUTION_STATUSES.has(ei.status)) continue;
    const prev = activeExecByPlanItem.get(ei.sourceEntityId);
    // Prefer the most-recently-scheduled active row (ties: keep first).
    if (
      !prev ||
      (ei.scheduledAt &&
        prev.scheduledAt &&
        new Date(ei.scheduledAt).getTime() >
          new Date(prev.scheduledAt).getTime())
    ) {
      activeExecByPlanItem.set(ei.sourceEntityId, {
        id: ei.id,
        status: ei.status,
        scheduledAt: ei.scheduledAt ?? null,
      });
    }
  }

  // Canonical schedule display per plan_item, computed once with the
  // workspace timezone so every card and every "today / tomorrow"
  // bucket sees the same wall clock.
  const workspaceTimezone = normalizeWorkspaceTimezone(timezoneLabel);
  const serverNow = new Date();
  const scheduleDisplayByItem = new Map<string, ScheduleDisplay>();
  for (const it of items) {
    const exec = activeExecByPlanItem.get(it.id) ?? null;
    scheduleDisplayByItem.set(
      it.id,
      formatScheduleDisplay({
        planItem: { scheduledAt: it.scheduledAt },
        executionItem: exec
          ? { status: exec.status, scheduledAt: exec.scheduledAt }
          : null,
        workspaceTimezone,
        serverNow,
      }),
    );
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
  const groups = groupByDay(items, scheduleDisplayByItem, workspaceTimezone);

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
      // Parse intent for the policy-aware creative gate. The shape
      // parser is strict about platform mismatch; here we use the
      // item's own platform as the expected platform (the policy
      // only cares about the intent string).
      const parsedIntent =
        it.platform && it.platformPublishIntent
          ? parsePlatformNativeShape(
              it.platformPublishIntent,
              it.platform as PublishPlatform,
            )?.intent ?? null
          : null;
      const missingParts = computeContinueWritingMissingParts({
        contentType: it.contentType,
        title: it.title,
        body: it.body,
        scheduledAt: it.scheduledAt,
        platform: it.platform,
        intent: parsedIntent,
        creativeAttached: creative !== null,
        creativeReason: creativeReadinessReason(creative),
      });
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
        status: it.status,
        title: it.title,
        body: it.body,
        platform: it.platform,
        contentType: it.contentType,
        platformPublishIntent: it.platformPublishIntent,
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
              status: creative.status,
            }
          : null,
      },
    }));

  return (
    <>
      {/*
        Reads ?focus=<itemId> on mount and scrolls/highlights the
        matching <article id="plan-item-<itemId>">. Used by the
        compose-sheet deep link so a freshly generated draft lands
        in view without the operator hunting for it.
      */}
      <FocusOnMount />
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
                      // Phase F7.4 — `isApprovable` drives the approve /
                      // hold / schedule / cancel-approval button gates.
                      // Articles, threads, link posts, etc. all become
                      // approvable through the centralized policy.
                      const parsedIntent =
                        it.platform && it.platformPublishIntent
                          ? parsePlatformNativeShape(
                              it.platformPublishIntent,
                              it.platform as PublishPlatform,
                            )?.intent ?? null
                          : null;
                      const isApprovable = isApprovablePublishObject({
                        platform: it.platform,
                        contentType: it.contentType,
                        intent: parsedIntent,
                      });
                      const creative = creativeByItem.get(it.id) ?? null;
                      // Policy-aware creative gate. Same intent parse
                      // as `isApprovable` above; the central
                      // `requiresCreative` decides whether a missing
                      // creative is a warning for this (platform,
                      // intent) tuple. A malformed attached creative
                      // still warns regardless of policy — see
                      // `_plan-item-warnings.ts`.
                      const warnings = computePlanItemWarnings({
                        contentType: it.contentType,
                        scheduledAt: it.scheduledAt,
                        platform: it.platform,
                        intent: parsedIntent,
                        creativeAttached: creative !== null,
                        creativeReason: creativeReadinessReason(creative),
                      });
                      const exec = execByPlanItem.get(it.id) ?? null;
                      const subreddit =
                        typeof it.metadata?.target === "string"
                          ? (it.metadata.target as string)
                          : null;
                      const notes =
                        typeof it.metadata?.operator_notes === "string"
                          ? (it.metadata.operator_notes as string)
                          : null;
                      const scheduleSource =
                        typeof it.metadata?.schedule_source === "string"
                          ? (it.metadata.schedule_source as string)
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
                          scheduleDisplay={
                            scheduleDisplayByItem.get(it.id) ??
                            formatScheduleDisplay({
                              planItem: { scheduledAt: it.scheduledAt },
                              workspaceTimezone,
                              serverNow,
                            })
                          }
                          scheduleSource={scheduleSource}
                          status={it.status}
                          riskScore={it.riskScore}
                          notes={notes}
                          isPost={isPost}
                          isApprovable={isApprovable}
                          warnings={warnings}
                          timezoneLabel={timezoneLabel}
                          subreddit={subreddit}
                          products={productOptions}
                          accounts={accountOptions}
                          allowedSubreddits={allowedSubreddits}
                          hasActiveContract={hasActiveContract}
                          executionItemId={exec?.id ?? null}
                          executionItemStatus={exec?.status ?? null}
                          platformPublishIntent={it.platformPublishIntent}
                          aiAssistedKind={deriveAiAssistedKind(
                            it.metadata as Record<string, unknown> | null,
                          )}
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

/**
 * Workspace-zone-aware Y/M/D for an instant. Returns the integer day
 * stamp (YYYY * 10000 + MM * 100 + DD) so deltas between two instants
 * collapse to a single integer comparison without re-parsing dates.
 */
function workspaceDayStamp(utcIso: string, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(utcIso));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return get("year") * 10000 + get("month") * 100 + get("day");
}

function bucketize(
  scheduledAt: string | null,
  now: Date,
  timezone: string,
): BucketId {
  if (!scheduledAt) return "unscheduled";
  const d = new Date(scheduledAt);
  if (Number.isNaN(d.getTime())) return "unscheduled";
  const itemStamp = workspaceDayStamp(scheduledAt, timezone);
  const nowStamp = workspaceDayStamp(now.toISOString(), timezone);
  if (itemStamp <= nowStamp) return "today";
  // Tomorrow: derive by walking forward one local day at noon UTC (a
  // representative instant far from any DST transition window), then
  // taking the stamp in the workspace zone.
  const oneDayMs = 24 * 60 * 60 * 1000;
  const tomorrowStamp = workspaceDayStamp(
    new Date(now.getTime() + oneDayMs).toISOString(),
    timezone,
  );
  if (itemStamp === tomorrowStamp) return "tomorrow";
  // For "this week" / "next week" we count workspace-local days
  // between the item and now. With small offsets and DST jumps a 1ms
  // imprecision is irrelevant — we're only deciding which 7-day
  // bucket the item lands in.
  const approxDayDelta = Math.round(
    (d.getTime() - now.getTime()) / oneDayMs,
  );
  // Days to next workspace-local Monday from now.
  const nowDow = new Date(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
      .format(now)
      .toString(),
  ).getDay();
  const daysUntilNextMonday = ((1 + 7 - nowDow) % 7) || 7;
  const daysUntilWeekAfter = daysUntilNextMonday + 7;
  if (approxDayDelta < daysUntilNextMonday) return "this_week";
  if (approxDayDelta < daysUntilWeekAfter) return "next_week";
  return "later";
}

function groupByDay(
  items: Awaited<ReturnType<typeof listPlanItems>>,
  scheduleDisplayByItem: Map<string, ScheduleDisplay>,
  timezone: string,
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
  function effectiveOf(itemId: string, fallback: string | null): string | null {
    const sd = scheduleDisplayByItem.get(itemId);
    return sd?.effectiveScheduledAt ?? fallback;
  }
  for (const it of items) {
    const effective = effectiveOf(it.id, it.scheduledAt);
    groups[bucketize(effective, now, timezone)].items.push(it);
  }
  // Sort items inside each bucket by EFFECTIVE scheduled time.
  for (const g of Object.values(groups)) {
    g.items.sort((a, b) => {
      const ea = effectiveOf(a.id, a.scheduledAt);
      const eb = effectiveOf(b.id, b.scheduledAt);
      const ta = ea ? new Date(ea).getTime() : Infinity;
      const tb = eb ? new Date(eb).getTime() : Infinity;
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
