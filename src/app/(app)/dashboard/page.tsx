import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { LockIcon } from "@/components/icons";
import { isSupabaseConfigured, createSupabaseServerClient } from "@/lib/supabase";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { listProducts } from "@/repositories/product-repository";
import { listAccounts } from "@/repositories/account-repository";
import {
  getCurrentWeeklyPlan,
  listPlanItems,
} from "@/repositories/weekly-plan-repository";
import { listRecentPublishes } from "@/repositories/publish-history-repository";
import { listPlatformConnections } from "@/repositories/platform-connection-repository";
import { listCreativesForItems } from "@/repositories/weekly-plan-creative-repository";
import { listExecutionItemsByPlanItemIds } from "@/repositories/execution-item-repository";
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
  const [products, accounts, plan, recentPublishes, connections] =
    await Promise.all([
      listProducts(workspaceId),
      listAccounts(workspaceId),
      getCurrentWeeklyPlan(workspaceId),
      listRecentPublishes(workspaceId, 30),
      listPlatformConnections(workspaceId),
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
    const timezoneLabel =
      (wsSettings as { timezone?: string | null } | null)?.timezone ?? null;
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
  const timezoneLabel =
    (wsSettings as { timezone?: string | null } | null)?.timezone ?? null;
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

  // ---- This week: today + tomorrow + a few upcoming ----
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const scheduled = items
    .filter((it) => !!it.scheduledAt)
    .filter((it) => it.contentType === "post")
    .sort((a, b) => {
      const ta = new Date(a.scheduledAt as string).getTime();
      const tb = new Date(b.scheduledAt as string).getTime();
      return ta - tb;
    });
  const todayPosts = scheduled.filter((it) => {
    const t = new Date(it.scheduledAt as string).getTime();
    return t >= startOfToday.getTime() && t < startOfToday.getTime() + dayMs;
  });
  const tomorrowPosts = scheduled.filter((it) => {
    const t = new Date(it.scheduledAt as string).getTime();
    return (
      t >= startOfToday.getTime() + dayMs &&
      t < startOfToday.getTime() + 2 * dayMs
    );
  });
  const upcomingPosts = scheduled
    .filter((it) => {
      const t = new Date(it.scheduledAt as string).getTime();
      return t >= startOfToday.getTime() + 2 * dayMs;
    })
    .slice(0, 5);

  // ---- Continue writing — drafts missing pieces ----
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
  const drafts = items
    .filter((it) => it.status === "draft" || it.status === "skipped")
    .slice(0, 4);

  // ---- Needs attention — failures, expired connections, Reddit blocker ----
  const redditBlocked = isRedditOauthBlocked();
  const needsAttention: NeedsAttentionEntry[] = [];
  const weekAgo = Date.now() - 7 * dayMs;
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
  // Posts with pending approval as a soft prompt.
  const pendingApproval = items.filter((it) => it.status === "pending_approval");
  if (pendingApproval.length > 0 && needsAttention.length < 5) {
    needsAttention.push({
      id: "pending-approval",
      message: `${pendingApproval.length} post${
        pendingApproval.length === 1 ? "" : "s"
      } waiting for your approval.`,
      href: "/weekly-plan",
      cta: "Review",
      severity: "info",
    });
  }
  if (redditBlocked && needsAttention.length < 5) {
    needsAttention.push({
      id: "reddit-blocker",
      message:
        "Reddit publishing is currently manual while their API approval is pending. Drafts still flow normally.",
      href: "/accounts",
      cta: "About",
      severity: "info",
    });
  }

  // ---- Recently published — 5 most recent successful publishes ----
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
    .slice(0, 5)
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
        {/* Needs attention — only when there's something to attend to */}
        <NeedsAttentionStrip entries={needsAttention} />

        {/* This week */}
        <section className="rounded-2xl border border-ink-200 bg-white p-5 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-ink-900">This week</h2>
            <Link
              href="/weekly-plan"
              className="text-xs text-signal-700 hover:text-signal-800"
            >
              Open weekly plan →
            </Link>
          </div>
          <WeekBlock label="Today" posts={todayPosts} emptyHint="Nothing scheduled for today." />
          <WeekBlock label="Tomorrow" posts={tomorrowPosts} emptyHint="Nothing scheduled for tomorrow." />
          {upcomingPosts.length > 0 ? (
            <WeekBlock label="Upcoming" posts={upcomingPosts} emptyHint={null} />
          ) : null}
        </section>

        {/* Recently published */}
        <RecentlyPublishedStrip entries={recentlyPublished} />

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
            <ul className="space-y-1.5">
              {drafts.map((d) => (
                <li key={d.id}>
                  <Link
                    href="/weekly-plan"
                    className="block rounded-md border border-ink-200 bg-white px-3 py-2 hover:bg-ink-50"
                  >
                    <div className="text-xs font-medium text-ink-900 truncate">
                      {d.title?.trim() || "Untitled draft"}
                    </div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {d.body?.slice(0, 80) || "No body yet"}
                    </div>
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

function WeekBlock({
  label,
  posts,
  emptyHint,
}: {
  label: string;
  posts: Awaited<ReturnType<typeof listPlanItems>>;
  emptyHint: string | null;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-500 font-semibold mb-1.5">
        {label}
      </div>
      {posts.length === 0 ? (
        emptyHint ? (
          <p className="text-xs text-ink-400 italic">{emptyHint}</p>
        ) : null
      ) : (
        <ul className="space-y-1.5">
          {posts.map((p) => (
            <li
              key={p.id}
              className="flex items-baseline justify-between gap-3 text-xs"
            >
              <Link
                href="/weekly-plan"
                className="text-ink-800 truncate hover:text-signal-700 min-w-0 flex-1"
              >
                {p.title?.trim() || "Untitled post"}
              </Link>
              <span className="text-[11px] text-ink-500 shrink-0">
                {p.scheduledAt
                  ? new Date(p.scheduledAt).toLocaleString(undefined, {
                      weekday: label === "Upcoming" ? "short" : undefined,
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
