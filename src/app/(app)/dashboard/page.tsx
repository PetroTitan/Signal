"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Topbar } from "@/components/topbar";
import { useSignal } from "@/core/store";
import { CadenceCallout } from "@/components/cadence-callout";
import { NextBestActions } from "@/components/operations-panels";
import { OnboardingChecklist } from "@/components/onboarding-checklist";

export default function DashboardPage() {
  const { state } = useSignal();

  const pendingCount = useMemo(
    () => state.items.filter((i) => i.status === "pending_approval").length,
    [state.items],
  );

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
