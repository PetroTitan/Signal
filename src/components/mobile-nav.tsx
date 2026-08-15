"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Mobile primary navigation.
 *
 * This used to sit in normal document flow at the end of the shell's
 * column, which meant it was not a bottom nav at all — on /weekly-plan
 * with a dozen cards, reaching navigation required scrolling past every
 * one of them. Signal is operated one-handed from a phone, so the
 * primary nav is now pinned.
 *
 * Pinning it makes two things load-bearing that previously were not:
 *   - the home-indicator inset (`env(safe-area-inset-bottom)`), which
 *     only resolves to a non-zero value because `app/layout.tsx` now
 *     declares `viewportFit: "cover"`; and
 *   - bottom padding on the shell's <main>, so the last card on every
 *     page is not parked underneath this bar.
 */

// Destinations unchanged — which pages belong in the mobile nav is a
// product decision, not a layout one.
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
    <nav
      aria-label="Primary"
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-ink-100 bg-white flex"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            // min-h-[44px] is the practical touch-target floor. Nothing
            // in the app reached it before; the primary navigation is
            // the least defensible place to miss it.
            className={`flex-1 min-w-0 min-h-[44px] flex items-center justify-center text-center px-1 text-xs truncate ${
              active
                ? "text-signal-800 font-semibold bg-signal-50 border-t-2 border-signal-600 -mt-px"
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
