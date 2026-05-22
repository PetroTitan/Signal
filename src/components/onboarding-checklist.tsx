"use client";

import Link from "next/link";
import { useMemo } from "react";
import { SectionHeader } from "./section-header";
import { CheckIcon, ChevronRightIcon, DotIcon } from "./icons";
import { useSignal } from "@/core/store";
import { sourceInsights as allSourceInsights } from "@/lib/mock";
import { useDemoData } from "@/lib/demo-data";

interface ChecklistRow {
  id: string;
  label: string;
  description: string;
  done: boolean;
  href: string;
  hrefLabel: string;
}

export function OnboardingChecklist() {
  const { state } = useSignal();
  const sourceInsights = useDemoData(allSourceInsights);
  const rows: ChecklistRow[] = useMemo(() => {
    const products = Object.values(state.productsById);
    const accounts = Object.values(state.accountsById);
    const eligibleAccounts = accounts.filter(
      (a) =>
        a.status === "active" ||
        a.status === "warming" ||
        a.status === "connected" ||
        a.status === "ready_to_connect",
    );
    const planItems = state.items;
    const approvedItems = planItems.filter((i) => i.status === "approved");

    return [
      {
        id: "products",
        label: "Configure product profiles",
        description:
          "Voice, CTA policy, forbidden claims, and risk tolerance for each product.",
        done: products.length > 0,
        href: "/products",
        hrefLabel: "Open products",
      },
      {
        id: "account",
        label: "Set up at least one eligible account",
        description:
          "Use the four-step wizard, complete the manual checklist, then mark ready for weekly planning.",
        done: eligibleAccounts.length > 0,
        href: "/accounts",
        hrefLabel: eligibleAccounts.length > 0 ? "Manage accounts" : "Add an account",
      },
      {
        id: "insight",
        label: "Add a source insight",
        description:
          "Founder observation, product lesson, support pattern. Signal turns insights into platform-native opportunities.",
        done: sourceInsights.length > 0,
        href: "/content-intelligence",
        hrefLabel: "Open content intelligence",
      },
      {
        id: "review",
        label: "Run a weekly review",
        description:
          "One calm pass through the approval queue. Approve, soften, delay, or save to backlog.",
        done: approvedItems.length > 0,
        href: "/approval-queue",
        hrefLabel: "Open approval queue",
      },
      {
        id: "schedule",
        label: "Redistribute the schedule",
        description:
          "Spread approved items across the week respecting platform cadence and account cooldown.",
        done: state.lastMoves.length > 0,
        href: "/scheduler",
        hrefLabel: "Open scheduler",
      },
      {
        id: "discoverability",
        label: "Scan discoverability opportunities",
        description:
          "Search-to-social, freshness windows, evergreen amplification — calm, deterministic recommendations.",
        done: false,
        href: "/discoverability",
        hrefLabel: "Open discoverability",
      },
    ];
  }, [state, sourceInsights]);

  const completed = rows.filter((r) => r.done).length;
  const pct = Math.round((completed / rows.length) * 100);

  return (
    <section className="card">
      <SectionHeader
        title="First-week checklist"
        hint="Six steps to a calm operating week. Skip what doesn't apply yet."
        link={{ href: "/workflow", label: "Full workflow" }}
        badge={
          <span className="badge bg-ink-100 text-ink-700">
            {completed}/{rows.length}
          </span>
        }
      />
      <div className="px-5 py-2.5">
        <div className="flex items-center justify-between text-xs text-ink-500 mb-1">
          <span>Setup progress</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-ink-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-signal-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <ul className="row-divider">
        {rows.map((row) => (
          <li key={row.id} className="px-5 py-3 flex items-start gap-3">
            <span
              className={`inline-flex h-5 w-5 items-center justify-center rounded-full mt-0.5 shrink-0 ${
                row.done
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-ink-100 text-ink-400"
              }`}
            >
              {row.done ? (
                <CheckIcon width={12} height={12} />
              ) : (
                <DotIcon width={10} height={10} />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <div
                className={`text-sm font-medium ${row.done ? "text-ink-500 line-through" : "text-ink-900"}`}
              >
                {row.label}
              </div>
              <p className="text-xs text-ink-600 mt-0.5">{row.description}</p>
            </div>
            <Link
              href={row.href}
              className="text-xs font-medium text-signal-700 hover:text-signal-800 inline-flex items-center gap-1 shrink-0"
            >
              {row.hrefLabel}
              <ChevronRightIcon width={12} height={12} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
