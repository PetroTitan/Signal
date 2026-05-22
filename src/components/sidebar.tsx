"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Operate",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
      { href: "/weekly-plan", label: "Weekly plan", icon: PlanIcon },
      { href: "/approval-queue", label: "Approval queue", icon: ApprovalIcon },
      { href: "/scheduler", label: "Scheduler", icon: SchedulerIcon },
      { href: "/backlog", label: "Backlog", icon: BacklogIcon },
      { href: "/activity", label: "Activity", icon: PlanIcon },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/content-intelligence", label: "Content intelligence", icon: InsightIcon },
      { href: "/opportunities", label: "Opportunities", icon: OpportunityIcon },
      { href: "/discussions", label: "Discussions", icon: DiscussionIcon },
      { href: "/comments", label: "Comments", icon: CommentIcon },
      { href: "/discoverability", label: "Discoverability", icon: DiscoverabilityIcon },
    ],
  },
  {
    label: "Platforms",
    items: [
      { href: "/platforms", label: "Platform overview", icon: PlatformsIcon, exact: true },
      { href: "/platforms/reddit", label: "Reddit", icon: PlatformsIcon },
      { href: "/platforms/x", label: "X", icon: PlatformsIcon },
      { href: "/platforms/linkedin", label: "LinkedIn", icon: PlatformsIcon },
      { href: "/platforms/google", label: "Google visibility", icon: SearchIcon },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/products", label: "Products", icon: ProductsIcon },
      { href: "/accounts", label: "Accounts", icon: AccountsIcon },
      { href: "/risk-center", label: "Risk center", icon: RiskIcon },
      { href: "/analytics", label: "Analytics", icon: AnalyticsIcon },
      { href: "/workflow", label: "Workflow", icon: PlatformsIcon },
      { href: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const session = useMaybeWorkspaceSession();

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
        {groups.map((group) => (
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
                          active ? "text-signal-600" : "text-ink-400 group-hover:text-ink-600"
                        }`}
                      />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
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
