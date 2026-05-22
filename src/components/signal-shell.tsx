"use client";

import { SignalProvider } from "@/core/store";
import { DemoModeProvider, useDemoMode } from "@/core/demo-mode";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import {
  accounts as mockAccounts,
  currentWeeklyPlan,
  initialBacklog,
  products as mockProducts,
  weeklyPlanItems as mockWeeklyPlanItems,
  workspace as mockWorkspace,
} from "@/lib/mock";
import type { GrowthAccount, ProductProfile, Workspace } from "@/types";

const emptyWorkspace: Workspace = {
  id: "ws_empty",
  name: "Your workspace",
  ownerName: "",
  ownerEmail: "",
  createdAt: new Date(0).toISOString(),
  philosophy: "Sustainable organic presence over posting volume.",
};

export function SignalShell({ children }: { children: React.ReactNode }) {
  return (
    <DemoModeProvider>
      <SeededShell>{children}</SeededShell>
    </DemoModeProvider>
  );
}

function SeededShell({ children }: { children: React.ReactNode }) {
  const { demoMode } = useDemoMode();

  const seed = demoMode
    ? {
        plan: currentWeeklyPlan,
        items: mockWeeklyPlanItems,
        backlog: initialBacklog,
        accounts: mockAccounts,
        products: mockProducts,
      }
    : {
        plan: { ...currentWeeklyPlan, status: "drafting" as const },
        items: [],
        backlog: [],
        accounts: [] as GrowthAccount[],
        products: [] as ProductProfile[],
      };

  // Keyed remount on mode switch so the store reseeds cleanly.
  return (
    <SignalProvider key={demoMode ? "demo" : "real"} seed={seed}>
      <DemoBanner />
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <main id="main-content" className="flex-1 min-w-0" tabIndex={-1}>
            {children}
          </main>
          <MobileNav />
        </div>
      </div>
    </SignalProvider>
  );
}

function DemoBanner() {
  const { demoMode } = useDemoMode();
  if (!demoMode) return null;
  return (
    <div className="bg-ink-900 text-white text-[11px] font-medium text-center py-1.5 px-4">
      Demo data — not connected to real accounts. Turn off in Settings.
    </div>
  );
}

// Suppress unused-import lint when workspace seed is needed in a future patch.
void emptyWorkspace;
