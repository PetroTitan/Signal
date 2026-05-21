"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  PlatformBadge,
  RiskBadge,
  AccountStatusBadge,
} from "@/components/badges";
import { EligibilityBadge } from "@/components/eligibility-badge";
import { ChevronRightIcon, LockIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import {
  calculatePlatformCadenceLoad,
  calculatePlatformReadiness,
  getPlatformContentFormats,
  getPlatformOpportunities,
  getPlatformPlaybook,
  getPlatformRecommendations,
  getPlatformRiskRules,
  getPlatformStrategy,
  getPlatformCadencePolicy,
} from "@/core/platforms";
import { computeReadiness } from "@/core/onboarding";
import { formatDateTime } from "@/lib/format";
import type {
  PlatformActionRecommendation,
  PlatformId,
  PlatformPlaybookModule,
  WeeklyPlanItem,
} from "@/types";

export function StrategyHeader({ platform }: { platform: PlatformId }) {
  const strategy = getPlatformStrategy(platform);
  return (
    <section className="card">
      <div className="px-5 py-4 border-b border-ink-100 flex items-center gap-3">
        <PlatformBadge platform={platform} />
        <div className="text-sm font-semibold text-ink-900">
          {strategy.strategicRole}
        </div>
      </div>
      <div className="px-5 py-4 space-y-3 text-sm">
        <div>
          <div className="stat-label">Primary growth objective</div>
          <p className="text-ink-800 mt-1 leading-relaxed">
            {strategy.primaryGrowthObjective}
          </p>
        </div>
        <div>
          <div className="stat-label">Tone &amp; voice</div>
          <p className="text-ink-800 mt-1 leading-relaxed">
            {strategy.toneVoice}
          </p>
        </div>
        <p className="text-ink-700 leading-relaxed">{strategy.longDescription}</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2">
          <Inline label="Approval behavior" text={strategy.approvalBehavior} />
          <Inline label="Scheduling behavior" text={strategy.schedulingBehavior} />
          <Inline label="Analytics expectations" text={strategy.analyticsExpectations} />
        </div>
      </div>
    </section>
  );
}

function Inline({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <p className="text-xs text-ink-700 mt-1 leading-relaxed">{text}</p>
    </div>
  );
}

export function PlatformStats({ platform }: { platform: PlatformId }) {
  const { state } = useSignal();
  const accounts = useMemo(
    () => Object.values(state.accountsById),
    [state.accountsById],
  );
  const readiness = calculatePlatformReadiness(platform, accounts);
  const load = calculatePlatformCadenceLoad(platform, state.items);
  const cadence = getPlatformCadencePolicy(platform);
  const platformItems = state.items.filter((i) => i.platform === platform);
  const backlog = state.backlog.filter((b) => b.platform === platform);

  const blocked = platformItems.filter((i) => i.risk.level === "blocked").length;
  const high = platformItems.filter((i) => i.risk.level === "high").length;
  const medium = platformItems.filter((i) => i.risk.level === "medium").length;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <Stat label="Readiness" value={`${readiness.overallScore}%`} sub={readinessLabel(readiness.status)} />
      <Stat
        label="Accounts"
        value={`${readiness.accountsEligible}/${readiness.accountsTotal}`}
        sub="eligible / total"
      />
      <Stat
        label="Scheduled"
        value={`${platformItems.length}`}
        sub={`${platformItems.filter((i) => i.status === "approved").length} approved`}
      />
      <Stat
        label="Backlog"
        value={`${backlog.length}`}
        sub="held for future"
      />
      <Stat
        label="Risk"
        value={`${high + blocked}`}
        sub={`${blocked} blocked · ${high} high · ${medium} medium`}
        tone={blocked > 0 || high > 0 ? "warn" : undefined}
      />
      <Stat
        label="Cadence"
        value={`${load.count}/${cadence.suggestedPostsPerWeek}`}
        sub={`${cadence.cadenceMode} · cap ${cadence.maxPostsPerWeek}`}
        tone={load.isOver ? "warn" : undefined}
      />
    </div>
  );
}

function readinessLabel(s: ReturnType<typeof calculatePlatformReadiness>["status"]) {
  return s === "ready" ? "Ready" : s === "in_setup" ? "In setup" : "Blocked";
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "warn";
}) {
  return (
    <div className="card-padded">
      <div className="stat-label">{label}</div>
      <div
        className={`text-xl font-semibold mt-1 ${tone === "warn" ? "text-amber-700" : "text-ink-900"}`}
      >
        {value}
      </div>
      {sub ? <div className="text-[11px] text-ink-500 mt-0.5">{sub}</div> : null}
    </div>
  );
}

export function RecommendationsCallout({
  platform,
}: {
  platform: PlatformId;
}) {
  const { state } = useSignal();
  const accounts = useMemo(
    () => Object.values(state.accountsById),
    [state.accountsById],
  );
  const recs = getPlatformRecommendations({
    platform,
    accounts,
    items: state.items,
    backlog: state.backlog,
  });
  if (recs.length === 0) return null;
  return (
    <div className="space-y-2">
      {recs.map((r) => (
        <RecLine key={r.id} rec={r} />
      ))}
    </div>
  );
}

function RecLine({ rec }: { rec: PlatformActionRecommendation }) {
  const tones = {
    info: "border-signal-200 bg-signal-50/40 text-ink-800",
    warn: "border-amber-200 bg-amber-50/50 text-ink-800",
    block: "border-red-200 bg-red-50/50 text-ink-900",
  };
  const dotTones = {
    info: "bg-signal-500",
    warn: "bg-amber-500",
    block: "bg-red-600",
  };
  return (
    <div className={`card ${tones[rec.level]} flex items-start gap-3 p-3.5 text-sm`}>
      <span
        className={`inline-block h-2 w-2 rounded-full mt-1.5 shrink-0 ${dotTones[rec.level]}`}
      />
      <div className="leading-relaxed">{rec.text}</div>
    </div>
  );
}

export function AccountsForPlatform({
  platform,
}: {
  platform: PlatformId;
}) {
  const { state } = useSignal();
  const accounts = useMemo(
    () =>
      Object.values(state.accountsById).filter((a) => a.platform === platform),
    [state.accountsById, platform],
  );

  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink-900">Accounts</div>
          <p className="text-xs text-ink-500 mt-0.5">
            {accounts.length} configured for this platform.
          </p>
        </div>
        <Link href="/accounts" className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1">
          Manage <ChevronRightIcon width={12} height={12} />
        </Link>
      </header>
      {accounts.length === 0 ? (
        <div className="px-5 py-4 text-sm text-ink-500">
          No accounts configured for this platform yet.
          <Link href="/accounts/new" className="ml-2 underline text-signal-700">
            Add one
          </Link>
          .
        </div>
      ) : (
        <ul className="row-divider">
          {accounts.map((a) => (
            <li key={a.id}>
              <Link
                href={`/accounts/${a.id}`}
                className="flex items-center gap-4 px-5 py-3 hover:bg-ink-50/60 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ink-900 truncate">
                    {a.displayName}
                    {a.handle ? (
                      <span className="ml-2 text-xs text-ink-500 font-normal">
                        {a.handle}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <AccountStatusBadge status={a.status} />
                    <EligibilityBadge status={a.status} compact />
                    <span className="text-xs text-ink-500 capitalize">
                      {a.role}
                    </span>
                  </div>
                </div>
                <div className="text-right shrink-0 hidden sm:block">
                  <div className="text-sm font-medium text-ink-900">
                    {computeReadiness(a)}%
                  </div>
                  <div className="text-[11px] text-ink-500">readiness</div>
                </div>
                <ChevronRightIcon className="text-ink-400" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ContentQueueForPlatform({
  platform,
  contentTypeFilter,
}: {
  platform: PlatformId;
  contentTypeFilter?: WeeklyPlanItem["contentType"][];
}) {
  const { state } = useSignal();
  const items = state.items
    .filter((i) => i.platform === platform)
    .filter((i) =>
      contentTypeFilter
        ? contentTypeFilter.includes(i.contentType)
        : true,
    )
    .sort(
      (a, b) =>
        new Date(a.scheduledFor).getTime() -
        new Date(b.scheduledFor).getTime(),
    );

  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink-900">
            Content queue
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            {items.length === 0
              ? "Nothing planned for this platform this week."
              : `${items.length} item${items.length === 1 ? "" : "s"} scheduled this week.`}
          </p>
        </div>
        <Link
          href="/weekly-plan"
          className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1"
        >
          Full plan <ChevronRightIcon width={12} height={12} />
        </Link>
      </header>
      {items.length > 0 ? (
        <ul className="row-divider">
          {items.map((item) => {
            const acc = state.accountsById[item.accountId];
            const product = state.productsById[item.productId];
            return (
              <li key={item.id} className="px-5 py-3.5">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <RiskBadge level={item.risk.level} score={item.risk.score} />
                  <span className="text-xs text-ink-500">
                    {product?.name} · {acc?.displayName}
                  </span>
                  <span className="text-xs text-ink-500 capitalize">
                    · {item.contentType.replace(/_/g, " ")}
                  </span>
                  <span className="ml-auto text-xs text-ink-400">
                    {formatDateTime(item.scheduledFor)}
                  </span>
                </div>
                <div className="text-sm text-ink-900 font-medium">
                  {item.draft.hook}
                </div>
                {item.draft.body ? (
                  <p className="text-xs text-ink-600 mt-1 line-clamp-2">
                    {item.draft.body}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export function PlaybookGrid({ platform }: { platform: PlatformId }) {
  const playbook = getPlatformPlaybook(platform);
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Playbook</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Modules that compose this platform&apos;s strategy. Active modules
          read from the live plan; placeholder modules are reserved for future
          API integrations.
        </p>
      </header>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3">
        {playbook.modules.map((m) => (
          <PlaybookCard key={m.id} module={m} />
        ))}
      </ul>
    </section>
  );
}

function PlaybookCard({ module }: { module: PlatformPlaybookModule }) {
  const tone =
    module.status === "active"
      ? "border-emerald-200 bg-emerald-50/30"
      : module.status === "passive"
        ? "border-ink-100 bg-white"
        : "border-dashed border-ink-200 bg-ink-50/30";
  const dot =
    module.status === "active"
      ? "bg-emerald-500"
      : module.status === "passive"
        ? "bg-signal-500"
        : "bg-ink-400";
  const statusLabel =
    module.status === "active"
      ? "Live"
      : module.status === "passive"
        ? "Guidance"
        : "Placeholder";
  return (
    <li className={`rounded-md border p-3 ${tone}`}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="text-sm font-semibold text-ink-900">{module.title}</div>
        <span className="inline-flex items-center gap-1 text-[10px] text-ink-600 uppercase tracking-wide font-semibold">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
          {statusLabel}
        </span>
      </div>
      <p className="text-xs text-ink-700 leading-snug">{module.description}</p>
    </li>
  );
}

export function RiskRulesList({ platform }: { platform: PlatformId }) {
  const rules = getPlatformRiskRules(platform);
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Risk rules</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Platform-specific signals the risk engine flags before approval.
        </p>
      </header>
      <ul className="row-divider">
        {rules.map((r) => (
          <li key={r.id} className="px-5 py-3">
            <div className="flex items-center justify-between gap-3 mb-1 flex-wrap">
              <div className="text-sm font-medium text-ink-900">{r.title}</div>
              <span
                className={
                  r.severity === "high"
                    ? "badge-high"
                    : r.severity === "medium"
                      ? "badge-medium"
                      : "badge-low"
                }
              >
                {r.severity}
              </span>
            </div>
            <p className="text-xs text-ink-700">{r.description}</p>
            <p className="text-xs text-ink-500 mt-1 italic">{r.mitigation}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ContentFormatsList({ platform }: { platform: PlatformId }) {
  const formats = getPlatformContentFormats(platform);
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Content formats</div>
        <p className="text-xs text-ink-500 mt-0.5">
          What this platform expects to see from each account role.
        </p>
      </header>
      <ul className="row-divider">
        {formats.map((f) => (
          <li key={f.id} className="px-5 py-3">
            <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
              <div className="text-sm font-medium text-ink-900">{f.label}</div>
              <span
                className={
                  f.promotionalLevel === "high"
                    ? "badge-high"
                    : f.promotionalLevel === "medium"
                      ? "badge-medium"
                      : "badge-low"
                }
              >
                {f.promotionalLevel} promo
              </span>
            </div>
            <p className="text-xs text-ink-700">{f.description}</p>
            <p className="text-[11px] text-ink-500 mt-1 capitalize">
              {f.recommendedFor === "all"
                ? "Recommended for all roles."
                : `Recommended for: ${f.recommendedFor.join(", ")}.`}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OpportunitiesList({ platform }: { platform: PlatformId }) {
  const { state } = useSignal();
  const products = useMemo(
    () => Object.values(state.productsById),
    [state.productsById],
  );
  const opps = getPlatformOpportunities(platform, products);
  if (opps.length === 0) return null;
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100">
        <div className="text-sm font-semibold text-ink-900">Opportunities</div>
        <p className="text-xs text-ink-500 mt-0.5">
          Surface-level prompts pulled from product profiles. None are
          published automatically.
        </p>
      </header>
      <ul className="grid grid-cols-1 md:grid-cols-2 gap-2 p-3">
        {opps.map((o) => (
          <li
            key={o.id}
            className="rounded-md border border-ink-100 p-3 bg-white"
          >
            <div className="text-sm font-semibold text-ink-900">{o.title}</div>
            <p className="text-xs text-ink-700 mt-1 leading-snug">{o.detail}</p>
            <div className="text-[10px] text-ink-500 mt-1.5 uppercase tracking-wide">
              {o.source.replace(/_/g, " ")}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AnalyticsPlaceholder({ platform }: { platform: PlatformId }) {
  const platformName =
    platform === "x" ? "X" : platform === "reddit" ? "Reddit" : "LinkedIn";
  return (
    <section className="card">
      <header className="px-5 py-3.5 border-b border-ink-100 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink-900">Analytics</div>
          <p className="text-xs text-ink-500 mt-0.5">
            {platformName} attribution will appear once WebmasterID is connected.
          </p>
        </div>
        <span className="badge bg-ink-100 text-ink-500">
          Data not yet connected
        </span>
      </header>
      <div className="px-5 py-4 text-sm text-ink-500 leading-relaxed">
        Tracking links are already shaped with utm_source, utm_medium,
        utm_campaign, signal_campaign_id, signal_item_id, product_id,
        platform, and account_id. Numbers will populate when the live
        analytics stream is connected. Signal will not display fake metrics
        in the meantime.
      </div>
    </section>
  );
}

export function OAuthFutureCard({ platform }: { platform: PlatformId }) {
  const platformName =
    platform === "x" ? "X" : platform === "reddit" ? "Reddit" : "LinkedIn";
  return (
    <section className="card border-signal-200 bg-signal-50/40">
      <div className="p-4 flex items-start gap-3 text-sm">
        <LockIcon className="text-signal-700 mt-0.5" />
        <div>
          <div className="font-semibold text-ink-900">
            {platformName} OAuth — not yet enabled
          </div>
          <p className="text-ink-700 mt-0.5 leading-relaxed">
            Signal will never ask for your {platformName} password, cookies,
            session tokens, 2FA codes, or recovery codes. When the official{" "}
            {platformName} OAuth ships, every account will connect through
            the platform&apos;s own authorization flow.
          </p>
        </div>
      </div>
    </section>
  );
}
