"use client";

import Link from "next/link";
import { useMemo } from "react";
import { PlatformBadge } from "@/components/badges";
import { SectionHeader } from "@/components/section-header";
import { ChevronRightIcon } from "@/components/icons";
import { useSignal } from "@/core/store";
import { deriveActivity, deriveDiscussionActivity } from "@/core/activity";
import { evaluateDiscussion } from "@/core/comment-intelligence";
import { calculateDiscoverabilityOpportunities } from "@/core/discoverability";
import {
  contentAssets as allContentAssets,
  discussionSeeds as allDiscussionSeeds,
  riskEvents as allRiskEvents,
  sourceInsights as allSourceInsights,
} from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";
import { relativeFromNow } from "@/lib/format";
import type { ActivityEvent } from "@/types";

export function NextBestActions() {
  const { state } = useSignal();
  const sourceInsights = useDemoData(allSourceInsights);
  const discussionSeeds = useDemoData(allDiscussionSeeds);
  const contentAssets = useDemoData(allContentAssets);
  const actions = useMemo(
    () => collectActions(state, { sourceInsights, discussionSeeds, contentAssets }),
    [state, sourceInsights, discussionSeeds, contentAssets],
  );
  if (actions.length === 0) {
    return (
      <section className="card">
        <SectionHeader
          title="Next best actions"
          hint="What to review next, ordered by judgment cost."
        />
        <div className="px-5 py-4 text-sm text-emerald-700">
          All clear. Nothing needs your judgment right now.
        </div>
      </section>
    );
  }
  return (
    <section className="card">
      <SectionHeader
        title="Next best actions"
        hint="What to review next, ordered by judgment cost."
      />
      <ul className="row-divider">
        {actions.slice(0, 5).map((a) => (
          <li key={a.id} className="px-5 py-3 flex items-start gap-3">
            <span
              className={`inline-block h-2 w-2 rounded-full mt-1.5 shrink-0 ${
                a.tone === "block"
                  ? "bg-red-600"
                  : a.tone === "warn"
                    ? "bg-amber-500"
                    : "bg-signal-500"
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-ink-900">{a.title}</div>
              <p className="text-xs text-ink-700 mt-0.5">{a.description}</p>
            </div>
            <Link
              href={a.href}
              className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1 shrink-0"
            >
              Open
              <ChevronRightIcon width={12} height={12} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ActionRow {
  id: string;
  title: string;
  description: string;
  href: string;
  tone: "info" | "warn" | "block";
}

function collectActions(
  state: ReturnType<typeof useSignal>["state"],
  data: {
    sourceInsights: typeof allSourceInsights;
    discussionSeeds: typeof allDiscussionSeeds;
    contentAssets: typeof allContentAssets;
  },
): ActionRow[] {
  const { sourceInsights, discussionSeeds, contentAssets } = data;
  const out: ActionRow[] = [];
  const products = Object.values(state.productsById);

  const blocked = state.items.filter((i) => i.risk.level === "blocked");
  if (blocked.length > 0) {
    out.push({
      id: "blocked_items",
      title: `${blocked.length} blocked item${blocked.length === 1 ? "" : "s"} in the plan`,
      description:
        "Move to backlog or fix the underlying account before reviewing further.",
      href: "/risk-center",
      tone: "block",
    });
  }

  const inSetup = Object.values(state.accountsById).filter(
    (a) =>
      a.status === "planned" ||
      a.status === "setup_needed" ||
      a.status === "awaiting_manual_creation",
  );
  if (inSetup.length > 0) {
    out.push({
      id: "accounts_in_setup",
      title: `${inSetup.length} account${inSetup.length === 1 ? "" : "s"} need setup`,
      description:
        "Complete manual setup, OAuth is reserved for when integrations ship.",
      href: "/accounts",
      tone: "warn",
    });
  }

  const pending = state.items.filter((i) => i.status === "pending_approval");
  if (pending.length > 0) {
    out.push({
      id: "pending_approval",
      title: `${pending.length} item${pending.length === 1 ? "" : "s"} awaiting your weekly review`,
      description: "One calm review per week — no daily decisions required.",
      href: "/approval-queue",
      tone: "info",
    });
  }

  const evaluatedDiscussions = discussionSeeds.map((seed) =>
    evaluateDiscussion({
      opportunity: seed,
      insights: sourceInsights,
      products,
    }),
  );
  const participateCount = evaluatedDiscussions.filter(
    (d) => d.recommendation === "participate",
  ).length;
  if (participateCount > 0) {
    out.push({
      id: "discussions_participate",
      title: `${participateCount} discussion thread${participateCount === 1 ? "" : "s"} worth participating in`,
      description: "Open the comments view for ready-to-soften drafts.",
      href: "/comments",
      tone: "info",
    });
  }

  const discoverabilityOpps = calculateDiscoverabilityOpportunities(
    contentAssets,
    products,
  );
  const highImpactGoogle = discoverabilityOpps.filter(
    (o) => o.impact === "high",
  );
  if (highImpactGoogle.length > 0) {
    out.push({
      id: "discoverability_high",
      title: `${highImpactGoogle.length} high-impact discoverability opportunit${highImpactGoogle.length === 1 ? "y" : "ies"}`,
      description: highImpactGoogle[0].suggestedAction,
      href: "/discoverability",
      tone: "warn",
    });
  }

  if (state.backlog.length > 0 && pending.length === 0) {
    out.push({
      id: "backlog_review",
      title: `${state.backlog.length} item${state.backlog.length === 1 ? "" : "s"} held in backlog`,
      description: "Review with the rest of the plan; restore only when cadence has room.",
      href: "/backlog",
      tone: "info",
    });
  }

  return out;
}

export function SystemHealth() {
  const { state } = useSignal();
  const checks = useMemo(() => collectHealth(state), [state]);
  return (
    <section className="card">
      <SectionHeader
        title="System health"
        hint="Are all engines healthy and the workspace coherent?"
      />
      <ul className="row-divider">
        {checks.map((c) => (
          <li
            key={c.id}
            className="px-5 py-2.5 flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                  c.status === "ok"
                    ? "bg-emerald-500"
                    : c.status === "warn"
                      ? "bg-amber-500"
                      : c.status === "block"
                        ? "bg-red-600"
                        : "bg-ink-300"
                }`}
              />
              <span className="text-sm text-ink-800">{c.label}</span>
            </div>
            <span className="text-xs text-ink-500">{c.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "block" | "pending";
  note: string;
}

function collectHealth(state: ReturnType<typeof useSignal>["state"]): HealthCheck[] {
  const items = state.items;
  const accounts = Object.values(state.accountsById);
  const products = Object.values(state.productsById);

  const checks: HealthCheck[] = [];

  checks.push({
    id: "products_configured",
    label: "Product profiles",
    status: products.length > 0 ? "ok" : "block",
    note: `${products.length} configured`,
  });

  const eligible = accounts.filter(
    (a) =>
      a.status === "active" ||
      a.status === "warming" ||
      a.status === "connected" ||
      a.status === "ready_to_connect",
  );
  checks.push({
    id: "accounts_eligible",
    label: "Eligible accounts",
    status:
      eligible.length === 0
        ? "block"
        : eligible.length < 2
          ? "warn"
          : "ok",
    note: `${eligible.length} of ${accounts.length}`,
  });

  const blocked = items.filter((i) => i.risk.level === "blocked").length;
  const high = items.filter((i) => i.risk.level === "high").length;
  checks.push({
    id: "risk_signals",
    label: "Risk signals",
    status: blocked > 0 ? "block" : high > 0 ? "warn" : "ok",
    note: `${blocked} blocked, ${high} high`,
  });

  const pending = items.filter((i) => i.status === "pending_approval").length;
  checks.push({
    id: "approval_queue",
    label: "Approval queue",
    status: pending > 0 ? "warn" : "ok",
    note: pending === 0 ? "Empty" : `${pending} pending`,
  });

  checks.push({
    id: "backlog",
    label: "Backlog",
    status: "ok",
    note: `${state.backlog.length} held`,
  });

  checks.push({
    id: "oauth_integrations",
    label: "OAuth integrations",
    status: "pending",
    note: "Not yet enabled",
  });

  checks.push({
    id: "webmasterid_analytics",
    label: "WebmasterID analytics",
    status: "pending",
    note: "Data not yet connected",
  });

  return checks;
}

export function WhatChangedThisWeek() {
  const { state } = useSignal();
  const sourceInsights = useDemoData(allSourceInsights);
  const discussionSeeds = useDemoData(allDiscussionSeeds);
  const contentAssets = useDemoData(allContentAssets);
  const riskEvents = useDemoData(allRiskEvents);
  const recent = useMemo<ActivityEvent[]>(() => {
    const products = Object.values(state.productsById);
    const evaluatedDiscussions = discussionSeeds.map((seed) =>
      evaluateDiscussion({
        opportunity: seed,
        insights: sourceInsights,
        products,
      }),
    );
    const base = deriveActivity({
      plan: state.plan,
      items: state.items,
      backlog: state.backlog,
      approvalEvents: state.approvalEvents,
      accountsById: state.accountsById,
      productsById: state.productsById,
      riskEvents,
      contentAssets,
      insights: sourceInsights,
      lastMoves: state.lastMoves,
    });
    const discussions = deriveDiscussionActivity({
      discussionOpportunities: evaluatedDiscussions,
    });
    const weekStart = new Date(state.plan.weekStartIso).getTime();
    return [...base, ...discussions]
      .filter((e) => new Date(e.occurredAt).getTime() >= weekStart - 7 * 24 * 60 * 60 * 1000)
      .sort(
        (a, b) =>
          new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
      )
      .slice(0, 6);
  }, [state, sourceInsights, discussionSeeds, contentAssets, riskEvents]);

  if (recent.length === 0) {
    return (
      <section className="card">
        <SectionHeader
          title="What changed this week"
          hint="Recent operational events."
          link={{ href: "/activity", label: "Open timeline" }}
        />
        <div className="px-5 py-4 text-sm text-ink-500">No recent events.</div>
      </section>
    );
  }

  return (
    <section className="card">
      <SectionHeader
        title="What changed this week"
        hint="Recent operational events across every engine."
        link={{ href: "/activity", label: "Open timeline" }}
      />
      <ul className="row-divider">
        {recent.map((event) => (
          <li key={event.id} className="px-5 py-3">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              {event.platform && event.platform !== "google" ? (
                <PlatformBadge platform={event.platform} />
              ) : event.platform === "google" ? (
                <span className="badge bg-ink-900 text-white">Google</span>
              ) : null}
              <span className="text-[11px] text-ink-500 uppercase tracking-wide">
                {event.type.replace(/_/g, " ")}
              </span>
              <span className="ml-auto text-[11px] text-ink-400">
                {relativeFromNow(event.occurredAt)}
              </span>
            </div>
            <div className="text-sm text-ink-900">{event.title}</div>
            <p className="text-xs text-ink-700 mt-0.5">{event.explanation}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ItemsNeedingJudgment() {
  const { state } = useSignal();
  const items = useMemo(() => {
    return state.items
      .filter(
        (i) =>
          i.status === "pending_approval" &&
          (i.risk.level === "medium" ||
            i.risk.level === "high" ||
            i.risk.level === "blocked"),
      )
      .sort((a, b) => b.risk.score - a.risk.score)
      .slice(0, 4);
  }, [state.items]);

  if (items.length === 0) {
    return (
      <section className="card">
        <SectionHeader
          title="Items needing human judgment"
          hint="Higher-risk pending items where a recommendation alone isn't enough."
        />
        <div className="px-5 py-4 text-sm text-emerald-700">
          Nothing requires judgment right now.
        </div>
      </section>
    );
  }
  return (
    <section className="card">
      <SectionHeader
        title="Items needing human judgment"
        hint="Higher-risk pending items where a recommendation alone isn't enough."
        link={{ href: "/approval-queue", label: "Open queue" }}
      />
      <ul className="row-divider">
        {items.map((item) => {
          const product = state.productsById[item.productId];
          return (
            <li key={item.id} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                <PlatformBadge platform={item.platform} />
                <span className="text-xs text-ink-500">{product?.name}</span>
                <span
                  className={`badge ${
                    item.risk.level === "blocked"
                      ? "bg-ink-900 text-white"
                      : item.risk.level === "high"
                        ? "badge-high"
                        : "badge-medium"
                  }`}
                >
                  {item.risk.level} · {item.risk.score}
                </span>
              </div>
              <div className="text-sm font-medium text-ink-900">
                {item.draft.hook}
              </div>
              <p className="text-xs text-ink-700 mt-1 italic">
                {item.risk.recommendation}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
