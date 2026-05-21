import Link from "next/link";
import { Topbar } from "@/components/topbar";
import {
  PlatformBadge,
  RiskBadge,
  AccountStatusBadge,
} from "@/components/badges";
import {
  accounts,
  currentWeeklyPlan,
  products,
  productsById,
  riskEvents,
  weeklyPlanItems,
  platforms,
} from "@/lib/mock";
import { formatDateRange, formatDateTime, relativeFromNow } from "@/lib/format";
import { ChevronRightIcon } from "@/components/icons";

export default function DashboardPage() {
  const pendingItems = weeklyPlanItems.filter(
    (i) => i.status === "pending_approval",
  );
  const upcoming = [...weeklyPlanItems]
    .filter((i) => i.status === "approved" || i.status === "scheduled")
    .sort(
      (a, b) =>
        new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime(),
    )
    .slice(0, 4);

  const platformDistribution = platforms.map((p) => ({
    platform: p,
    count: weeklyPlanItems.filter((i) => i.platform === p.id).length,
  }));

  const activeAccounts = accounts.filter((a) => a.status === "active").length;
  const warmingAccounts = accounts.filter((a) => a.status === "warming").length;
  const plannedAccounts = accounts.filter(
    (a) =>
      a.status === "planned" ||
      a.status === "setup_needed" ||
      a.status === "awaiting_manual_creation",
  ).length;

  const highRisk = riskEvents.filter((r) => r.level === "high").length;
  const mediumRisk = riskEvents.filter((r) => r.level === "medium").length;

  return (
    <>
      <Topbar
        title="Operations dashboard"
        description={`Week of ${formatDateRange(currentWeeklyPlan.weekStartIso, currentWeeklyPlan.weekEndIso)}. ${currentWeeklyPlan.pendingCount} items awaiting your review.`}
        actions={
          <>
            <Link href="/weekly-plan" className="btn">
              Open weekly plan
            </Link>
            <Link href="/approval-queue" className="btn-primary">
              Review {currentWeeklyPlan.pendingCount} pending
            </Link>
          </>
        }
      />

      <div className="px-6 lg:px-8 py-6 space-y-6 max-w-7xl">
        {/* Top stat row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="This week's plan"
            value={`${currentWeeklyPlan.itemCount} items`}
            sub={`${currentWeeklyPlan.approvedCount} approved · ${currentWeeklyPlan.pendingCount} pending`}
          />
          <StatCard
            label="Connected accounts"
            value={`${activeAccounts + warmingAccounts} / ${accounts.length}`}
            sub={`${warmingAccounts} warming · ${plannedAccounts} planned`}
          />
          <StatCard
            label="Active products"
            value={`${products.length}`}
            sub="Spanning analytics, finance, utility, consulting"
          />
          <StatCard
            label="Risk signals"
            value={`${highRisk + mediumRisk}`}
            sub={`${highRisk} high · ${mediumRisk} medium`}
            tone={highRisk > 0 ? "warn" : "neutral"}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Pending approvals */}
          <section className="card lg:col-span-2">
            <Header
              title="Pending approvals"
              hint={`${pendingItems.length} items waiting for your single weekly review`}
              link={{ href: "/approval-queue", label: "Open queue" }}
            />
            <ul className="row-divider">
              {pendingItems.map((item) => {
                const product = productsById[item.productId];
                return (
                  <li
                    key={item.id}
                    className="px-5 py-3.5 flex items-start gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <PlatformBadge platform={item.platform} />
                        <span className="text-xs text-ink-500">
                          {product.name}
                        </span>
                        <RiskBadge level={item.riskLevel} />
                      </div>
                      <div className="text-sm font-medium text-ink-900 truncate">
                        {item.draft.hook}
                      </div>
                      <div className="text-xs text-ink-500 mt-1">
                        {formatDateTime(item.scheduledFor)} ·{" "}
                        {relativeFromNow(item.scheduledFor)}
                      </div>
                    </div>
                  </li>
                );
              })}
              {pendingItems.length === 0 ? (
                <li className="px-5 py-6 text-sm text-ink-500">
                  Nothing pending. The week is approved.
                </li>
              ) : null}
            </ul>
          </section>

          {/* Platform distribution */}
          <section className="card">
            <Header
              title="Platform distribution"
              hint="This week's planned items"
            />
            <ul className="px-5 py-4 space-y-3">
              {platformDistribution.map(({ platform, count }) => {
                const pct = Math.round(
                  (count / Math.max(weeklyPlanItems.length, 1)) * 100,
                );
                return (
                  <li key={platform.id}>
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <PlatformBadge platform={platform.id} />
                        <span className="text-xs text-ink-500">
                          suggested {platform.cadenceGuidance.suggestedPostsPerWeek}/wk
                        </span>
                      </div>
                      <span className="text-sm font-medium text-ink-800">
                        {count}
                      </span>
                    </div>
                    <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-signal-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Upcoming */}
          <section className="card lg:col-span-2">
            <Header
              title="Upcoming this week"
              hint="Approved items scheduled for organic distribution"
              link={{ href: "/scheduler", label: "Open scheduler" }}
            />
            <ul className="row-divider">
              {upcoming.map((item) => {
                const product = productsById[item.productId];
                return (
                  <li
                    key={item.id}
                    className="px-5 py-3.5 flex items-center gap-4"
                  >
                    <div className="text-xs font-mono text-ink-500 w-28 shrink-0">
                      {formatDateTime(item.scheduledFor)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <PlatformBadge platform={item.platform} />
                        <span className="text-xs text-ink-500">
                          {product.name}
                        </span>
                      </div>
                      <div className="text-sm text-ink-800 truncate">
                        {item.draft.hook}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Account readiness */}
          <section className="card">
            <Header title="Accounts" link={{ href: "/accounts", label: "Manage" }} />
            <ul className="row-divider">
              {accounts.slice(0, 5).map((a) => (
                <li key={a.id} className="px-5 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ink-900 truncate">
                      {a.displayName}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <PlatformBadge platform={a.platform} />
                      <AccountStatusBadge status={a.status} />
                    </div>
                  </div>
                  <div className="text-xs text-ink-500 shrink-0">
                    {a.readinessScore}%
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Bottom row: risk + analytics readiness */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="card lg:col-span-2">
            <Header
              title="Risk signals"
              hint="Cadence, tone, and account fatigue checks"
              link={{ href: "/risk-center", label: "Open risk center" }}
            />
            <ul className="row-divider">
              {riskEvents.slice(0, 4).map((r) => (
                <li key={r.id} className="px-5 py-3.5">
                  <div className="flex items-center gap-2 mb-1">
                    <RiskBadge level={r.level} />
                    <span className="text-xs text-ink-500 capitalize">
                      {r.category.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="text-sm text-ink-800">{r.summary}</div>
                  <div className="text-xs text-ink-500 mt-1">
                    {r.recommendation}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <Header
              title="Analytics readiness"
              hint="WebmasterID integration"
              link={{ href: "/analytics", label: "View" }}
            />
            <div className="px-5 py-4 space-y-3 text-sm">
              <ReadinessRow label="UTM tagging" status="ready" />
              <ReadinessRow label="Signal campaign IDs" status="ready" />
              <ReadinessRow label="Per-account attribution" status="pending" />
              <ReadinessRow label="WebmasterID connection" status="not_connected" />
              <ReadinessRow label="Conversion stream" status="not_connected" />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div className={`stat-value mt-1 ${tone === "warn" ? "text-amber-700" : ""}`}>
        {value}
      </div>
      {sub ? <div className="text-xs text-ink-500 mt-1">{sub}</div> : null}
    </div>
  );
}

function Header({
  title,
  hint,
  link,
}: {
  title: string;
  hint?: string;
  link?: { href: string; label: string };
}) {
  return (
    <div className="px-5 py-3.5 border-b border-ink-100 flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-semibold text-ink-900">{title}</div>
        {hint ? <div className="text-xs text-ink-500 mt-0.5">{hint}</div> : null}
      </div>
      {link ? (
        <Link
          href={link.href}
          className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1"
        >
          {link.label}
          <ChevronRightIcon width={12} height={12} />
        </Link>
      ) : null}
    </div>
  );
}

function ReadinessRow({
  label,
  status,
}: {
  label: string;
  status: "ready" | "pending" | "not_connected";
}) {
  const tone =
    status === "ready"
      ? "bg-emerald-500"
      : status === "pending"
        ? "bg-amber-500"
        : "bg-ink-300";
  const statusLabel =
    status === "ready"
      ? "Ready"
      : status === "pending"
        ? "Pending"
        : "Not connected";
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${tone}`} />
        <span className="text-ink-800">{label}</span>
      </div>
      <span className="text-xs text-ink-500">{statusLabel}</span>
    </div>
  );
}
