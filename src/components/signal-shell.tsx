"use client";

import { SignalProvider } from "@/core/store";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import {
  accounts,
  currentWeeklyPlan,
  initialBacklog,
  products,
  weeklyPlanItems,
} from "@/lib/mock";

export function SignalShell({ children }: { children: React.ReactNode }) {
  return (
    <SignalProvider
      seed={{
        plan: currentWeeklyPlan,
        items: weeklyPlanItems,
        backlog: initialBacklog,
        accounts,
        products,
      }}
    >
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
