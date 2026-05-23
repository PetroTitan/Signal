"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOutAction } from "@/app/(auth)/_actions";
import { useMaybeWorkspaceSession } from "@/core/workspace-session";
import {
  DashboardIcon,
  ProductsIcon,
  AccountsIcon,
  PlanIcon,
  ApprovalIcon,
  SchedulerIcon,
  RiskIcon,
  AnalyticsIcon,
  SettingsIcon,
  BacklogIcon,
  PlatformsIcon,
  SearchIcon,
  DiscoverabilityIcon,
  InsightIcon,
  CommentIcon,
  DiscussionIcon,
  OpportunityIcon,
} from "./icons";
import { BrandMark } from "./brand-mark";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  exact?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
  /** Visually de-emphasize and collapse by default. */
  advanced?: boolean;
};

const groups: NavGroup[] = [
  {
    label: "Publish",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
      { href: "/weekly-plan", label: "Weekly plan", icon: PlanIcon },
      { href: "/execution", label: "Publishing", icon: SchedulerIcon },
      { href: "/accounts", label: "Accounts", icon: AccountsIcon },
      { href: "/products", label: "Products", icon: ProductsIcon },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/weekly-contracts", label: "Publishing scope", icon: ApprovalIcon },
      { href: "/settings", label: "Settings", icon: SettingsIcon, exact: true },
    ],
  },
  {
    label: "Advanced",
    advanced: true,
    items: [
      { href: "/approval-queue", label: "Approval queue", icon: ApprovalIcon },
      { href: "/scheduler", label: "Scheduler", icon: SchedulerIcon },
      { href: "/backlog", label: "Backlog", icon: BacklogIcon },
      { href: "/activity", label: "Activity", icon: PlanIcon },
      { href: "/risk-center", label: "Risk center", icon: RiskIcon },
      { href: "/analytics", label: "Analytics", icon: AnalyticsIcon },
      { href: "/workflow", label: "Workflow", icon: PlatformsIcon },
      { href: "/content-intelligence", label: "Content intelligence", icon: InsightIcon },
      { href: "/opportunities", label: "Opportunities", icon: OpportunityIcon },
      { href: "/discussions", label: "Discussions", icon: DiscussionIcon },
      { href: "/comments", label: "Comments", icon: CommentIcon },
      { href: "/discoverability", label: "Discoverability", icon: DiscoverabilityIcon },
      { href: "/platforms", label: "Platform overview", icon: PlatformsIcon, exact: true },
      { href: "/platforms/reddit", label: "Reddit", icon: PlatformsIcon },
      { href: "/platforms/x", label: "X", icon: PlatformsIcon },
      { href: "/platforms/linkedin", label: "LinkedIn", icon: PlatformsIcon },
      { href: "/platforms/google", label: "Google visibility", icon: SearchIcon },
      { href: "/settings/mcp", label: "MCP operations", icon: SettingsIcon },
      { href: "/operator-bridge", label: "Operator bridge", icon: InsightIcon },
      { href: "/imports", label: "Import assistant", icon: InsightIcon },
    ],
  },
];

function isPathInGroup(pathname: string, group: NavGroup): boolean {
  return group.items.some(({ href, exact }) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(href + "/"),
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const session = useMaybeWorkspaceSession();

  // Advanced group collapsed by default; auto-open when the active route lives inside it.
  const advancedGroup = groups.find((g) => g.advanced);
  const advancedActive = advancedGroup
    ? isPathInGroup(pathname, advancedGroup)
    : false;
  const [advancedOpen, setAdvancedOpen] = useState(advancedActive);
  useEffect(() => {
    if (advancedActive) setAdvancedOpen(true);
  }, [advancedActive]);

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-ink-100 bg-white">
      <div className="px-5 py-5">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-ink-900"
          aria-label="Signal home"
        >
          <BrandMark size={20} />
          <span className="text-sm font-semibold tracking-tight">Signal</span>
        </Link>
        {session ? (
          <div className="mt-2 text-[11px] text-ink-500 leading-tight truncate">
            <div className="text-ink-700 truncate">{session.workspace.name}</div>
            <div className="truncate">{session.user.email}</div>
          </div>
        ) : null}
      </div>
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {groups.map((group) => {
          if (group.advanced) {
            return (
              <div key={group.label} className="mb-5 last:mb-0">
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-2 pb-1.5 text-[10px] font-semibold tracking-wider text-ink-400 uppercase hover:text-ink-600"
                  aria-expanded={advancedOpen}
                >
                  <span>{group.label}</span>
                  <span
                    className={`text-ink-400 transition-transform ${
                      advancedOpen ? "rotate-90" : ""
                    }`}
                    aria-hidden
                  >
                    ›
                  </span>
                </button>
                {advancedOpen ? (
                  <ul className="space-y-0.5">
                    {group.items.map(({ href, label, icon: Icon, exact }) => {
                      const active = exact
                        ? pathname === href
                        : pathname === href ||
                          pathname.startsWith(href + "/");
                      return (
                        <li key={href}>
                          <Link
                            href={href}
                            className={`group flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                              active
                                ? "bg-ink-100 text-ink-900 font-medium"
                                : "text-ink-500 hover:bg-ink-50 hover:text-ink-800"
                            }`}
                          >
                            <Icon
                              className={`shrink-0 ${
                                active
                                  ? "text-signal-600"
                                  : "text-ink-300 group-hover:text-ink-500"
                              }`}
                            />
                            {label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            );
          }
          return (
            <div key={group.label} className="mb-5 last:mb-0">
              <div className="px-2 pb-1.5 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
                {group.label}
              </div>
              <ul className="space-y-0.5">
                {group.items.map(({ href, label, icon: Icon, exact }) => {
                  const active = exact
                    ? pathname === href
                    : pathname === href || pathname.startsWith(href + "/");
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        className={`group flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors ${
                          active
                            ? "bg-ink-100 text-ink-900 font-medium"
                            : "text-ink-700 hover:bg-ink-50 hover:text-ink-900"
                        }`}
                      >
                        <Icon
                          className={`shrink-0 ${
                            active
                              ? "text-signal-600"
                              : "text-ink-400 group-hover:text-ink-600"
                          }`}
                        />
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
      {session ? (
        <form action={signOutAction} className="border-t border-ink-100 px-3 py-3">
          <button
            type="submit"
            className="w-full text-left text-xs text-ink-600 hover:text-ink-900 px-2.5 py-1.5 rounded-md hover:bg-ink-50"
          >
            Sign out
          </button>
        </form>
      ) : null}
    </aside>
  );
}
