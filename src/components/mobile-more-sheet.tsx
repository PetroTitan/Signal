"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOutAction } from "@/app/(auth)/_actions";
import { useMaybeWorkspaceSession } from "@/core/workspace-session";
import { can } from "@/core/teams/permissions";
import {
  SECONDARY_ROUTES,
  visibleTo,
  type NavGroupKey,
  type RouteEntry,
} from "@/core/navigation/route-manifest";

/**
 * The mobile secondary navigation.
 *
 * Why a sheet rather than more tabs
 * ---------------------------------
 * The bottom bar carries the five daily destinations. A sixth tab would
 * put every tab under ~53px at 320px, and there are eighteen secondary
 * destinations — the bar is not where that growth belongs.
 *
 * Why not the Topbar
 * ------------------
 * There is no avatar or profile menu to improve; the Topbar renders
 * only a title, a description and an actions slot. A top-right control
 * would also be the least one-handed corner of a phone. The bottom bar
 * is already pinned, safe-area aware, and where a thumb rests.
 *
 * This is the ONLY way to reach /settings/mcp, /notifications and
 * /backlog on a phone — before it, those routes existed but had no
 * mobile path at all.
 *
 * Every destination comes from the route manifest. This component
 * keeps no list of its own.
 */

const GROUP_LABEL: Record<NavGroupKey, string> = {
  publish: "Publish",
  setup: "Workspace & settings",
  advanced: "Advanced",
};

const GROUP_ORDER: NavGroupKey[] = ["publish", "setup", "advanced"];

export function MobileMoreSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const session = useMaybeWorkspaceSession();
  const role = session?.role ?? null;

  // Close on route change so the sheet never survives a navigation.
  useEffect(() => {
    if (open) onClose();
    // Only pathname should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Escape closes, matching the other dialogs in the app.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const visible = visibleTo(SECONDARY_ROUTES, role, can);
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: visible.filter((r) => (r.group ?? "publish") === group),
  })).filter((g) => g.items.length > 0);

  return (
    <div
      className="lg:hidden fixed inset-0 z-50 flex items-end"
      role="dialog"
      aria-modal="true"
      aria-label="More destinations"
    >
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-ink-900/40 cursor-default"
      />
      <div
        // Bounded height with its own scroller: the list is long and
        // must never make the page itself scroll.
        className="relative w-full max-h-[85vh] flex flex-col bg-white rounded-t-2xl shadow-2xl overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-ink-100 shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink-900">More</div>
            {session ? (
              <div className="text-[11px] text-ink-500 truncate">
                {session.workspace.name}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost text-xs min-h-[44px]"
          >
            Close
          </button>
        </div>

        <nav
          aria-label="Secondary"
          className="flex-1 overflow-y-auto px-3 py-3 space-y-4"
        >
          {grouped.map(({ group, items }) => (
            <div key={group}>
              <div className="px-2 pb-1.5 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
                {GROUP_LABEL[group]}
              </div>
              <ul className="space-y-0.5">
                {items.map((item) => (
                  <li key={item.href}>
                    <MoreLink item={item} pathname={pathname} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {session ? (
          <form
            action={signOutAction}
            className="border-t border-ink-100 px-3 py-3 shrink-0"
          >
            {/* Sign out had no mobile surface at all — it lived only in
                the desktop sidebar's footer. */}
            <button
              type="submit"
              className="btn-secondary w-full min-h-[44px] text-sm"
            >
              Sign out
            </button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function MoreLink({
  item,
  pathname,
}: {
  item: RouteEntry;
  pathname: string;
}) {
  const active =
    pathname === item.href || pathname.startsWith(item.href + "/");
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`block rounded-md px-2.5 py-2.5 min-h-[44px] transition-colors ${
        active ? "nav-item-active" : "text-ink-800 hover:bg-ink-50"
      }`}
    >
      <span className="text-sm font-medium block truncate">{item.label}</span>
      {item.description ? (
        <span className="text-[11px] text-ink-500 block leading-snug">
          {item.description}
        </span>
      ) : null}
    </Link>
  );
}
