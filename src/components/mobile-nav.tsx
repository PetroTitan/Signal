"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PRIMARY_ROUTES } from "@/core/navigation/route-manifest";
import { MobileMoreSheet } from "./mobile-more-sheet";

/**
 * Mobile primary navigation.
 *
 * The five daily destinations come from the route manifest — this file
 * no longer keeps its own list, which is how it drifted ten
 * destinations behind the desktop sidebar.
 *
 * The sixth control is More, not a sixth destination. It opens the
 * secondary sheet, which is the only mobile path to /settings/mcp,
 * /notifications, /backlog and every other settings route. Six controls
 * at 320px give ~53px each — tight but workable with truncation, and
 * the alternative (an eighteen-item bottom bar, or no path at all) is
 * worse.
 *
 * Pinned, safe-area aware and 44px tall; the shell reserves matching
 * bottom padding so content is never parked underneath.
 */

export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // Any route that is not a primary destination is "under More", so the
  // More control shows as current rather than leaving the bar with no
  // active state at all — which is what a settings page looked like.
  const onPrimary = PRIMARY_ROUTES.some(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
  );

  return (
    <>
      <nav
        aria-label="Primary"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-ink-100 bg-white flex"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {PRIMARY_ROUTES.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex-1 min-w-0 min-h-[44px] flex items-center justify-center text-center px-0.5 text-[11px] truncate ${
                active
                  ? "text-signal-800 font-semibold bg-signal-50 border-t-2 border-signal-600 -mt-px"
                  : "text-ink-500"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-label="More destinations and settings"
          className={`flex-1 min-w-0 min-h-[44px] flex items-center justify-center text-center px-0.5 text-[11px] truncate ${
            !onPrimary
              ? "text-signal-800 font-semibold bg-signal-50 border-t-2 border-signal-600 -mt-px"
              : "text-ink-500"
          }`}
        >
          More
        </button>
      </nav>
      <MobileMoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}
