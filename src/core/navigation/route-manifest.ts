/**
 * Authenticated route manifest — the single source of truth for what
 * exists, where it is reachable from, and who may see it.
 *
 * The defect this exists to prevent
 * ---------------------------------
 * Navigation was defined twice and incompletely. `sidebar.tsx` held 15
 * destinations inside `<aside className="hidden lg:flex …">`;
 * `mobile-nav.tsx` held 5; `topbar.tsx` held none. Nothing reconciled
 * them, so ten desktop destinations were invisible below 1024px.
 *
 * `/settings/mcp` was the sharpest case. Its ONLY navigational entry in
 * the entire application was `sidebar.tsx:64` — inside the desktop-only
 * aside, inside the "Advanced" group, which is collapsed by default.
 * `/settings` itself did not link to it either. So on a phone there was
 * no path to MCP at all, and an operator had to know the URL.
 *
 * `/notifications` and `/backlog` were in the same position with no
 * in-app link of any kind outside the sidebar.
 *
 * The rule
 * --------
 * Every authenticated page route appears here EXACTLY ONCE with an
 * explicit tier. A route with no home is a decision, not an accident —
 * "contextual" and "internal" are real answers, but they must be
 * chosen. `route-manifest.test.ts` walks the App Router tree and fails
 * when a page exists that this file does not classify, so a new route
 * cannot become accidentally invisible.
 *
 * Hidden navigation is NOT security. `permission` here decides what is
 * worth showing; the server actions, repositories and RLS remain the
 * authorization boundary and are unchanged by this file.
 *
 * Pure. No I/O, no React, no `server-only` — the sidebar, the mobile
 * nav, the More sheet, the settings hub and the guard test all read it.
 */

import type { Permission } from "@/core/teams/permissions";

/**
 * Where a route is reachable from.
 *
 *   primary     the mobile bottom bar and the desktop sidebar — the
 *               handful of destinations an operator uses every day
 *   secondary   the mobile More sheet and the desktop sidebar — real
 *               operator surfaces that are not daily
 *   settings    the Settings hub, plus More and the sidebar
 *   contextual  reached from a list or a card, never from a nav menu.
 *               Detail routes live here: /accounts/[id] is reached by
 *               tapping an account, and a nav entry for it would be
 *               meaningless
 *   internal    diagnostics an operator reaches deliberately; kept out
 *               of the primary surfaces on purpose
 */
export type NavTier =
  | "primary"
  | "secondary"
  | "settings"
  | "contextual"
  | "internal"
  /**
   * The route exists and nothing links to it.
   *
   * This tier is a finding, not a design. It is here so an unreachable
   * page is recorded as unreachable rather than quietly described as
   * "contextual" — which is what the first version of this manifest
   * did, asserting a `reachableFrom` that the guard then failed to
   * verify.
   */
  | "orphaned";

/** Grouping inside the More sheet and the sidebar. */
export type NavGroupKey = "publish" | "setup" | "advanced";

export interface RouteEntry {
  /** Route pattern as it appears in the App Router tree. */
  href: string;
  /** Operator-facing label. Uses Signal's existing terminology — these
   *  are the strings the sidebar and Topbar already use. */
  label: string;
  tier: NavTier;
  group?: NavGroupKey;
  /** One line for the Settings hub and the More sheet. */
  description?: string;
  /**
   * Permission required to SEE the entry. Absent means everyone with a
   * workspace sees it.
   *
   * Again: this hides an entry, it does not protect a route. Every one
   * of these pages enforces its own access server-side.
   */
  permission?: Permission;
  /** True for dynamic segments — excluded from every nav surface. */
  dynamic?: boolean;
  /** Why a contextual/internal route has no nav entry. Required for
   *  those tiers so the classification is auditable rather than a
   *  shrug. */
  reachableFrom?: string;
}

export const AUTHENTICATED_ROUTES: ReadonlyArray<RouteEntry> = [
  // ── Primary: the daily loop ──────────────────────────────────────
  {
    href: "/dashboard",
    label: "Home",
    tier: "primary",
    group: "publish",
    description: "This week at a glance.",
  },
  {
    href: "/weekly-plan",
    label: "Plan",
    tier: "primary",
    group: "publish",
    description: "Draft, approve and schedule posts.",
  },
  {
    href: "/execution",
    label: "Publishing",
    tier: "primary",
    group: "publish",
    description: "Queues, attempts and publish history.",
  },
  {
    href: "/accounts",
    label: "Accounts",
    tier: "primary",
    group: "setup",
    description: "Publishing identities and their connections.",
  },
  {
    href: "/products",
    label: "Products",
    tier: "primary",
    group: "setup",
    description: "What you are publishing about.",
  },

  // ── Secondary: real surfaces, not daily ──────────────────────────
  {
    href: "/library",
    label: "Content library",
    tier: "secondary",
    group: "publish",
    description: "Everything written, across weeks.",
  },
  {
    href: "/results",
    label: "Results",
    tier: "secondary",
    group: "publish",
    description: "What each published post did.",
  },
  {
    href: "/account-health",
    label: "Account health",
    tier: "secondary",
    group: "publish",
    description: "Audience, cadence and repetition signals per identity.",
  },
  {
    href: "/strategy",
    label: "Strategy",
    tier: "secondary",
    group: "publish",
    description: "What to post next, with the evidence behind each option.",
  },
  {
    href: "/relationships",
    label: "Relationships",
    tier: "secondary",
    group: "publish",
    description:
      "Import a Bluesky profile's followers, then follow or unfollow accounts you pick.",
    // Same permission that gates connecting an account: a follow acts
    // as the operator's account in public. This hides the entry; the
    // server actions enforce it.
    permission: "connect_platforms",
  },
  {
    href: "/relationships/campaigns",
    label: "Follow campaigns",
    tier: "secondary",
    group: "publish",
    description:
      "Queue profiles and follow them on a daily schedule you approve.",
    // Same permission as the manual relationship actions: a campaign
    // follows real people from the operator's account in public, and
    // unattended. This hides the entry; the server actions enforce it.
    permission: "connect_platforms",
  },
  {
    href: "/relationships/campaigns/setup",
    label: "Start automatic following",
    // Reached from the primary call to action on /relationships rather
    // than from navigation: it is a task you begin from the page you
    // are already on, not a place you go.
    tier: "contextual",
    group: "publish",
    description:
      "Choose an imported list and a daily amount, then let Signal follow them for you.",
    reachableFrom:
      "The primary 'Start automatic following' call to action on /relationships — in the page header at every width, and in the panel shown when no campaign is running.",
    permission: "connect_platforms",
  },
  {
    href: "/relationships/unfollow",
    label: "Unfollow people",
    // Reached from the primary call to action on /relationships rather
    // than from navigation, for the same reason as the follow setup: it
    // is a task you begin from the page you are already on.
    tier: "contextual",
    group: "publish",
    description:
      "Choose who to stop following and a daily amount, then let Signal work through the list.",
    reachableFrom:
      "The 'Unfollow people…' call to action on /relationships — in the page header at every width, beside 'Start automatic following', and in the imported-list panel.",
    // The same permission as manual Follow/Unfollow and automatic
    // following. This one deletes public relationships unattended, so
    // it gets the strictest gate the matrix has, never a weaker one.
    permission: "connect_platforms",
  },
  {
    href: "/relationships/unfollow/[id]",
    label: "Unfollow campaign",
    dynamic: true,
    tier: "contextual",
    group: "publish",
    description:
      "What one unfollow campaign has done, and the controls to pause, resume, cancel or stop the account.",
    reachableFrom:
      "The campaign list on /relationships/unfollow, and the link shown after a campaign is started.",
    permission: "connect_platforms",
  },
  // ── LinkedIn Sales: manual tasks from lists the customer holds ────
  {
    href: "/linkedin",
    label: "LinkedIn Sales",
    tier: "secondary",
    group: "publish",
    description:
      "Prepare manual LinkedIn tasks from lists your organisation already holds. You perform every LinkedIn step yourself.",
  },
  {
    href: "/linkedin/tasks",
    label: "LinkedIn tasks",
    tier: "contextual",
    group: "publish",
    description: "The manual tasks waiting for you: copy the draft, open the profile, act, mark completed.",
    reachableFrom: "The section tabs on every /linkedin page (_subnav.tsx) and the overview's 'Go to tasks' call to action.",
  },
  {
    href: "/linkedin/leads",
    label: "LinkedIn leads",
    tier: "contextual",
    group: "publish",
    description: "Lead lists and imports of customer-provided profile URLs.",
    reachableFrom: "The section tabs on every /linkedin page (_subnav.tsx) and the overview.",
  },
  {
    href: "/linkedin/sequences",
    label: "LinkedIn sequences",
    tier: "contextual",
    group: "publish",
    description: "The ordered manual steps a campaign prepares for you.",
    reachableFrom: "The section tabs on every /linkedin page (_subnav.tsx).",
  },
  {
    href: "/linkedin/campaigns",
    label: "LinkedIn campaigns",
    tier: "contextual",
    group: "publish",
    description: "A list paired with a sequence; start, pause, resume, cancel.",
    reachableFrom: "The section tabs on every /linkedin page (_subnav.tsx) and the overview.",
  },
  {
    href: "/linkedin/analytics",
    label: "LinkedIn analytics",
    tier: "contextual",
    group: "publish",
    description: "Counts of what Signal prepared and what you confirmed. No LinkedIn metrics.",
    reachableFrom: "The section tabs on every /linkedin page (_subnav.tsx) and the overview.",
  },
  {
    href: "/linkedin/compliance",
    label: "LinkedIn compliance",
    tier: "contextual",
    group: "publish",
    description: "The capability registry, suppression list, audit events, retention and deletion tools.",
    reachableFrom: "The section tabs on every /linkedin page (_subnav.tsx) and the boundary notice on every page.",
  },
  {
    href: "/measurement-health",
    label: "Measurement health",
    tier: "secondary",
    group: "advanced",
    description: "Whether measurement is running, and what is broken if not.",
  },
  {
    href: "/notifications",
    label: "Notifications",
    tier: "secondary",
    group: "publish",
    description: "What needs your attention.",
  },
  {
    href: "/backlog",
    label: "Backlog",
    tier: "secondary",
    group: "publish",
    description: "Ideas parked for later.",
  },
  {
    href: "/weekly-contracts",
    label: "Publishing scope",
    tier: "secondary",
    group: "publish",
    description: "What Signal is allowed to publish this week.",
  },
  {
    href: "/activity",
    label: "Activity",
    tier: "secondary",
    group: "publish",
    description: "Audit trail of every change.",
  },

  // ── Settings ─────────────────────────────────────────────────────
  {
    href: "/settings",
    label: "Settings",
    tier: "settings",
    group: "setup",
    description: "Workspace, connections, AI and trust.",
  },
  {
    href: "/settings/setup",
    label: "Setup guide",
    tier: "settings",
    group: "setup",
    description: "Connect publishing, step by step.",
  },
  {
    href: "/settings/publishing-platforms",
    label: "Publishing platforms",
    tier: "settings",
    group: "setup",
    description: "Where Signal can publish, and what is configured.",
    permission: "connect_platforms",
  },
  {
    href: "/settings/mcp",
    label: "MCP & AI integrations",
    tier: "settings",
    group: "setup",
    // The route this whole milestone exists for.
    description: "Connect Claude or Codex to this workspace.",
    permission: "manage_settings",
  },
  {
    href: "/settings/mcp/tokens",
    label: "Operator tokens",
    tier: "settings",
    group: "setup",
    description: "Create and revoke MCP access tokens.",
    permission: "manage_settings",
  },
  {
    href: "/settings/team",
    label: "Team & access",
    tier: "settings",
    group: "setup",
    description: "Members, roles and invitations.",
    permission: "manage_members",
  },
  {
    href: "/settings/ai-memory",
    label: "AI memory",
    tier: "settings",
    group: "setup",
    description: "What Signal remembers when drafting.",
  },
  {
    href: "/settings/network",
    label: "Region & network",
    tier: "settings",
    group: "setup",
    description: "Where requests originate.",
    permission: "manage_settings",
  },

  // ── Internal / diagnostics ───────────────────────────────────────
  {
    href: "/operator-bridge",
    label: "Operator bridge",
    tier: "internal",
    group: "advanced",
    description: "Hand a task to an external operator.",
    permission: "manage_settings",
  },

  // ── Contextual: reached by tapping a row, never from a menu ───────
  {
    // ORPHANED, verified: the only links to it are in
    // components/command-center.tsx, which is rendered nowhere
    // (`CommandCenter` has zero consumers). Meanwhile /accounts embeds
    // AccountCreateForm inline at page.tsx:532, so identity creation
    // already works without this page.
    //
    // Left in place deliberately: deleting a route is a product
    // decision, not a navigation one. Recorded so it is visible.
    href: "/accounts/new",
    label: "Add identity",
    tier: "orphaned",
    reachableFrom:
      "Nothing links here. /accounts embeds the create form inline; this standalone page is redundant.",
  },
  {
    // ORPHANED, verified. /accounts does not link here — it manages
    // identities inline via IdentityCardWithManage (page.tsx:510). The
    // only remaining links are in command-center.tsx (rendered nowhere)
    // and /accounts/new, which is itself orphaned.
    //
    // Like /products/[slug], this is a "use client" page reading the
    // demo store rather than the identity repository, so linking it
    // would not show real data. Same product decision required.
    href: "/accounts/[id]",
    label: "Identity detail",
    tier: "orphaned",
    dynamic: true,
    reachableFrom:
      "Nothing live links here. /accounts manages identities inline; this page reads the demo store.",
  },
  {
    // ORPHANED, verified. Its only linker is core/search/index.ts,
    // which has no consumers.
    //
    // Do NOT "fix" this by linking product cards to it: the page reads
    // the client-side demo store (useSignal().state.productsById, whose
    // ProductProfile carries a slug) while /products reads the real
    // products repository, whose Product type has no slug and whose
    // table has no slug column. Every real product would render
    // "Product not found" — a worse outcome than no link.
    //
    // Reaching it needs a product decision about slugs, not a nav fix.
    href: "/products/[slug]",
    label: "Product detail",
    tier: "orphaned",
    dynamic: true,
    reachableFrom:
      "Nothing links here. The page resolves against the demo store; real products have no slug.",
  },
  {
    href: "/execution/[id]",
    label: "Queue detail",
    tier: "contextual",
    dynamic: true,
    reachableFrom: "/execution — tapping a queue.",
  },
  {
    href: "/execution/items/[id]",
    label: "Publish detail",
    tier: "contextual",
    dynamic: true,
    reachableFrom:
      "/execution and the weekly-plan card — tapping a scheduled item.",
  },
  {
    href: "/weekly-contracts/[id]",
    label: "Scope detail",
    tier: "contextual",
    dynamic: true,
    reachableFrom: "/weekly-contracts — tapping a scope.",
  },
  {
    href: "/operator-bridge/[id]",
    label: "Bridge request detail",
    tier: "contextual",
    dynamic: true,
    reachableFrom: "/operator-bridge — tapping a request.",
  },
  {
    href: "/invite/accept",
    label: "Accept invitation",
    tier: "contextual",
    reachableFrom: "An emailed invitation link. Never in-app navigation.",
  },
];

// =====================================================================
// Derivations — every nav surface reads these, none keeps its own list
// =====================================================================

/** The mobile bottom bar and the sidebar's top group. */
export const PRIMARY_ROUTES: ReadonlyArray<RouteEntry> =
  AUTHENTICATED_ROUTES.filter((r) => r.tier === "primary");

/** Everything the More sheet offers, in tier then declaration order. */
export const SECONDARY_ROUTES: ReadonlyArray<RouteEntry> =
  AUTHENTICATED_ROUTES.filter(
    (r) => r.tier === "secondary" || r.tier === "settings" || r.tier === "internal",
  );

/** The Settings hub's contents. */
export const SETTINGS_ROUTES: ReadonlyArray<RouteEntry> =
  AUTHENTICATED_ROUTES.filter((r) => r.tier === "settings");

/** Routes that appear in no navigation surface, by decision. */
export const NON_NAVIGABLE_ROUTES: ReadonlyArray<RouteEntry> =
  AUTHENTICATED_ROUTES.filter((r) => r.tier === "contextual");

/** Routes with no inbound link anywhere. A finding to act on, not a design. */
export const ORPHANED_ROUTES: ReadonlyArray<RouteEntry> =
  AUTHENTICATED_ROUTES.filter((r) => r.tier === "orphaned");

/**
 * Filter a route list by what this role may see.
 *
 * A null role (session still loading, or no membership) is treated as
 * unprivileged: the entry is hidden rather than flashed and withdrawn.
 */
export function visibleTo(
  routes: ReadonlyArray<RouteEntry>,
  role: Parameters<typeof import("@/core/teams/permissions").can>[0],
  can: typeof import("@/core/teams/permissions").can,
): RouteEntry[] {
  return routes.filter((r) => !r.permission || can(role, r.permission));
}

/** Look up an entry by exact href. */
export function routeEntry(href: string): RouteEntry | null {
  return AUTHENTICATED_ROUTES.find((r) => r.href === href) ?? null;
}
