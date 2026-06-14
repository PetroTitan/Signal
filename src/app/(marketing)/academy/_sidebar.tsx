"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SidebarArticle {
  slug: string;
  title: string;
}
export interface SidebarSection {
  id: string;
  title: string;
  group: string;
  articles: SidebarArticle[];
}

export function AcademySidebar({
  groups,
}: {
  groups: { group: string; sections: SidebarSection[] }[];
}) {
  const pathname = usePathname();
  return (
    <nav className="text-sm" aria-label="Academy">
      <Link
        href="/academy"
        className={`block px-2 py-1.5 rounded-md font-medium ${
          pathname === "/academy"
            ? "bg-ink-100 text-ink-900"
            : "text-ink-700 hover:bg-ink-50 hover:text-ink-900"
        }`}
      >
        Academy home
      </Link>
      {groups.map(({ group, sections }) => (
        <div key={group} className="mt-5">
          <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            {group}
          </div>
          {sections.map((section) => (
            <div key={section.id} className="mb-3">
              <div className="px-2 pt-1 text-[11px] font-semibold text-ink-600">
                {section.title}
              </div>
              <ul className="mt-0.5">
                {section.articles.map((a) => {
                  const href = `/academy/${a.slug}`;
                  const active = pathname === href;
                  return (
                    <li key={a.slug}>
                      <Link
                        href={href}
                        className={`block px-2 py-1 rounded-md leading-snug ${
                          active
                            ? "bg-ink-100 text-ink-900 font-medium"
                            : "text-ink-600 hover:bg-ink-50 hover:text-ink-900"
                        }`}
                      >
                        {a.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}
