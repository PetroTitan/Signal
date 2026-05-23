"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/dashboard", label: "Home" },
  { href: "/weekly-plan", label: "Plan" },
  { href: "/execution", label: "Publishing" },
  { href: "/accounts", label: "Accounts" },
  { href: "/products", label: "Products" },
];

export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav className="lg:hidden border-t border-ink-100 bg-white flex">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex-1 text-center py-2.5 text-xs ${
              active
                ? "text-signal-700 font-medium border-t-2 border-signal-600 -mt-px"
                : "text-ink-500"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
