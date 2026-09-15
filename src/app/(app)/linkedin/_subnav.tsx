"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface LinkedInSection {
  href: string;
  label: string;
  exact?: boolean;
}

export const LINKEDIN_SECTIONS: readonly LinkedInSection[] = [
  { href: "/linkedin", label: "Overview", exact: true },
  { href: "/linkedin/tasks", label: "Tasks" },
  { href: "/linkedin/leads", label: "Leads" },
  { href: "/linkedin/sequences", label: "Sequences" },
  { href: "/linkedin/campaigns", label: "Campaigns" },
  { href: "/linkedin/analytics", label: "Analytics" },
  { href: "/linkedin/compliance", label: "Compliance" },
];

/**
 * Section tabs. The current page is announced with aria-current and
 * shown with weight and an underline — never colour alone. The row
 * scrolls inside itself on a narrow screen instead of widening the page.
 */
export function LinkedInSubnav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="LinkedIn Sales sections" className="-mx-4 sm:mx-0 overflow-x-auto">
      <ul className="flex gap-1 list-none p-0 m-0 px-4 sm:px-0 min-w-max border-b border-ink-200">
        {LINKEDIN_SECTIONS.map((s) => {
          const current = s.exact ? pathname === s.href : pathname === s.href || pathname.startsWith(`${s.href}/`);
          return (
            <li key={s.href}>
              <Link
                href={s.href}
                aria-current={current ? "page" : undefined}
                className={
                  "inline-flex items-center min-h-11 px-3 text-sm border-b-2 -mb-px focus:outline-none focus:ring-2 focus:ring-signal-500 rounded-t-md " +
                  (current
                    ? "border-signal-600 text-signal-800 font-semibold"
                    : "border-transparent text-ink-600 hover:text-ink-900 hover:border-ink-300")
                }
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
