/**
 * The data-mode boundary makes "is this real or demo?" a first-class concept.
 *
 * Pages should never decide what to render by reading mock arrays directly.
 * They ask the boundary instead — see use-data-mode.ts.
 */

export type DataMode = "real" | "demo";

export interface DataModeInfo {
  mode: DataMode;
  isReal: boolean;
  isDemo: boolean;
}

export function describeDataMode(mode: DataMode): DataModeInfo {
  return { mode, isReal: mode === "real", isDemo: mode === "demo" };
}

/**
 * The label every page must render when showing demo content.
 */
export const DEMO_LABEL = "Demo preview";
export const DEMO_DESCRIPTION =
  "This data is not connected to real accounts.";

/**
 * Honest copy used by the real-empty path. Centralized so it stays
 * consistent across the product.
 */
export const REAL_EMPTY_COPY = {
  noConnectedAccounts: {
    title: "No connected accounts yet",
    hint: "Add an account and connect through official OAuth when integrations are enabled.",
    cta: { href: "/accounts/new", label: "Add account" },
  },
  noWeeklyPlan: {
    title: "No weekly plan yet",
    hint: "Add a product and an account before generating a weekly plan.",
    cta: { href: "/products", label: "Add product" },
  },
  noOpportunities: {
    title: "No opportunities yet",
    hint: "Opportunities surface here once a product profile and an account are connected.",
    cta: { href: "/products", label: "Add product" },
  },
  noDiscoverability: {
    title: "Discoverability data not connected",
    hint: "Visibility, freshness, and topical coverage appear here once Search Console is connected.",
    cta: { href: "/products", label: "Add product" },
  },
  noActivity: {
    title: "No activity yet",
    hint: "Signal will log operational events here once a product and an account are connected.",
    cta: { href: "/accounts/new", label: "Add account" },
  },
  noInsights: {
    title: "No insights yet",
    hint: "Add a product to capture founder observations and source insights.",
    cta: { href: "/products", label: "Add product" },
  },
  noPlatformActivity: {
    title: "Not connected yet",
    hint: "Connect an account through official OAuth when integrations are enabled.",
    cta: { href: "/accounts/new", label: "Add account" },
  },
  noRiskItems: {
    title: "Nothing to review yet",
    hint: "Risk surfaces here once a weekly plan is generated.",
    cta: { href: "/accounts/new", label: "Add account" },
  },
} as const;

export type RealEmptyKey = keyof typeof REAL_EMPTY_COPY;
