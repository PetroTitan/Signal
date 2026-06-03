/**
 * SSR tab navigation for the Weekly Plan workflow views.
 *
 * Dashboard Organization Pass — Phase 2. Renders the Queue / Scheduled
 * / Published / Paused / Failed (and the default Plan) tabs as plain
 * links carrying `?tab=`. No client JS, fully accessible (a labelled
 * <nav> of real anchors with aria-current), and it reflects only the
 * tabs the caller decides to show (e.g. Failed is omitted when there
 * is no failed data).
 */

import Link from "next/link";
import type { WorkflowTab, WorkflowTabMeta } from "@/core/dashboard/workflow-filters";

export interface WorkflowTabsProps {
  tabs: readonly WorkflowTabMeta[];
  active: WorkflowTab;
  basePath: string;
  /** Optional per-tab count badge (e.g. { queue: 3, scheduled: 12 }). */
  counts?: Partial<Record<WorkflowTab, number>>;
}

export function WorkflowTabs({ tabs, active, basePath, counts }: WorkflowTabsProps) {
  return (
    <nav aria-label="Workflow views" className="border-b border-ink-100">
      <ul className="flex flex-wrap items-center gap-1 -mb-px overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          // The default tab ("plan") drops the query param entirely so
          // the canonical URL stays clean.
          const href =
            tab.id === "plan" ? basePath : `${basePath}?tab=${tab.id}`;
          const count = counts?.[tab.id];
          return (
            <li key={tab.id}>
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`group inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-t-md border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? "border-signal-600 text-ink-900 font-semibold"
                    : "border-transparent text-ink-500 hover:text-ink-800 hover:border-ink-200"
                }`}
              >
                {tab.label}
                {typeof count === "number" && count > 0 ? (
                  <span
                    className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-[10px] font-medium ${
                      isActive
                        ? "bg-signal-100 text-signal-700"
                        : "bg-ink-100 text-ink-600 group-hover:bg-ink-200"
                    }`}
                  >
                    {count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
