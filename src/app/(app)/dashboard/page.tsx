"use client";

import Link from "next/link";
import { Topbar } from "@/components/topbar";
import { useSignal } from "@/core/store";
import { useIsDemo } from "@/lib/demo-data";
import { CadenceCallout } from "@/components/cadence-callout";
import { NextBestActions } from "@/components/operations-panels";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { LockIcon } from "@/components/icons";

export default function DashboardPage() {
  const { state } = useSignal();
  const isDemo = useIsDemo();

  const hasProducts = Object.values(state.productsById).length > 0;
  const hasAccounts = Object.values(state.accountsById).length > 0;
  const hasAnyData = hasProducts || hasAccounts || state.items.length > 0;

  if (!hasAnyData && !isDemo) {
    return <EmptyDashboard />;
  }

  const pendingCount = state.items.filter(
    (i) => i.status === "pending_approval",
  ).length;

  return (
    <>
      <Topbar
        title="This week"
        description="One calm review. Approve, soften, or move to the backlog."
        actions={
          pendingCount > 0 ? (
            <Link href="/approval-queue" className="btn-primary">
              Review {pendingCount}
            </Link>
          ) : (
            <Link href="/weekly-plan" className="btn">
              Open plan
            </Link>
          )
        }
      />
      <div className="px-6 lg:px-10 py-8 space-y-8 max-w-5xl">
        <CadenceCallout />
        <NextBestActions />
        <OnboardingChecklist />
      </div>
    </>
  );
}

function EmptyDashboard() {
  return (
    <>
      <Topbar
        title="Welcome"
        description="A calm operating surface for sustainable growth."
      />
      <div className="px-6 lg:px-10 py-16 max-w-2xl space-y-10">
        <section>
          <h2 className="text-base font-semibold text-ink-900">
            Start with one product, one account.
          </h2>
          <p className="text-sm text-ink-600 mt-2 leading-relaxed">
            Signal turns founder observations into platform-native opportunities,
            distributes them across a calm week, and never publishes without your
            approval.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/accounts/new" className="btn-primary">
              Add your first account
            </Link>
            <Link href="/products" className="btn">
              Create a product profile
            </Link>
          </div>
        </section>

        <section className="card p-4 flex items-start gap-3 text-sm">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-signal-100 text-signal-700 shrink-0">
            <LockIcon />
          </span>
          <div>
            <div className="font-semibold text-ink-900">OAuth-first by design</div>
            <p className="text-ink-700 mt-0.5 leading-relaxed">
              Signal never asks for platform passwords. Accounts connect through
              OAuth when integrations are enabled.
            </p>
          </div>
        </section>

        <section className="text-xs text-ink-500 leading-relaxed">
          <p>
            Supabase persistence is planned, not connected yet. Turn on Demo data
            in{" "}
            <Link
              href="/settings"
              className="text-signal-700 hover:text-signal-800"
            >
              Settings
            </Link>{" "}
            to explore the workflow with sample data.
          </p>
        </section>
      </div>
    </>
  );
}
