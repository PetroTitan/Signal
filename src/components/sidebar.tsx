"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
} from "./icons";

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Operate",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
      { href: "/weekly-plan", label: "Weekly plan", icon: PlanIcon },
      { href: "/approval-queue", label: "Approval queue", icon: ApprovalIcon },
      { href: "/scheduler", label: "Scheduler", icon: SchedulerIcon },
      { href: "/backlog", label: "Backlog", icon: BacklogIcon },
      { href: "/risk-center", label: "Risk center", icon: RiskIcon },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/products", label: "Products", icon: ProductsIcon },
      { href: "/accounts", label: "Accounts", icon: AccountsIcon },
      { href: "/analytics", label: "Analytics", icon: AnalyticsIcon },
      { href: "/settings", label: "Settings", icon: SettingsIcon },
    ],
  },
];

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
};

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-ink-100 bg-white">
      <div className="px-5 py-5 border-b border-ink-100">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-ink-900 text-white text-[11px] font-semibold tracking-wide">
            SG
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ink-900">Signal</div>
            <div className="text-[11px] text-ink-500">Growth operations</div>
          </div>
        </Link>
      </div>
      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.label} className="mb-5 last:mb-0">
            <div className="px-2 pb-1.5 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon }) => {
                const active =
                  pathname === href || pathname.startsWith(href + "/");
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
      <div className="px-4 py-4 border-t border-ink-100 text-[11px] text-ink-500 leading-relaxed">
        <div className="font-medium text-ink-700 mb-0.5">Sustainable cadence</div>
        Signal plans weekly. Approve once. Stay calm.
      </div>
    </aside>
  );
}
