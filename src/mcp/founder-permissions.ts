/**
 * Phase F5.2 — founder-readable permission groups.
 *
 * The technical scopes in `mcp/permissions.ts` use vocabulary the
 * dispatcher cares about (`workspace:read`, `weekly_plans:write_pending`,
 * etc.). The founder UI groups those into a small number of calm,
 * founder-readable buckets so creating a token feels like ticking
 * "what should this assistant be allowed to help with" rather than
 * "what scope strings should I include".
 *
 * Each group resolves to the subset of ALLOWED_SCOPES the underlying
 * dispatcher actually checks. Groups never include BLOCKED_SCOPES.
 */

import { ALLOWED_SCOPES, type AllowedScope } from "./permissions";

export interface FounderPermissionGroup {
  /** Stable key used as the form input value. */
  key: string;
  /** Founder-readable label rendered next to the checkbox. */
  label: string;
  /** One-sentence explanation rendered under the label. */
  description: string;
  /** Technical scopes this group grants when checked. */
  scopes: readonly AllowedScope[];
  /** True when the group should be checked by default for new tokens. */
  defaultChecked: boolean;
}

export const FOUNDER_PERMISSION_GROUPS: ReadonlyArray<FounderPermissionGroup> = [
  {
    key: "read_workspace",
    label: "Read drafts and identities",
    description:
      "The assistant can read products, identities, and existing drafts. Required for almost everything else.",
    scopes: [
      "workspace:read",
      "products:read",
      "accounts:read",
      "weekly_plans:read",
      "contracts:read",
    ],
    defaultChecked: true,
  },
  {
    key: "prepare_drafts",
    label: "Prepare drafts",
    description:
      "The assistant can create new draft posts in your weekly plan. Drafts land as draft — you still approve before publishing.",
    scopes: ["weekly_plans:write_pending"],
    defaultChecked: true,
  },
  {
    key: "prepare_products",
    label: "Prepare product profiles",
    description:
      "The assistant can submit new product profiles for your review. They land as pending_review.",
    scopes: ["products:write_pending"],
    defaultChecked: false,
  },
  {
    key: "prepare_identities",
    label: "Prepare publishing identities",
    description:
      "The assistant can submit new publishing identities for your review.",
    scopes: ["accounts:write_pending"],
    defaultChecked: false,
  },
  {
    key: "review_publishing_history",
    label: "Review publishing history",
    description:
      "The assistant can read past publishes, their permalinks, and outcomes. Read-only.",
    scopes: ["execution:read"],
    defaultChecked: true,
  },
  {
    key: "dry_run_execution",
    label: "Dry-run publishing checks",
    description:
      "The assistant can simulate the publishing pipeline without making any external API calls.",
    scopes: ["execution:dry_run"],
    defaultChecked: false,
  },
  {
    key: "run_verification",
    label: "Run trust + verification checks",
    description:
      "The assistant can run Signal's safety and verification probes (read-only).",
    scopes: ["verification:run"],
    defaultChecked: false,
  },
  {
    key: "prepare_imports",
    label: "Prepare imports",
    description:
      "The assistant can submit import requests (e.g. product or identity bulk imports) for your review.",
    scopes: ["imports:prepare"],
    defaultChecked: false,
  },
  {
    key: "write_reports",
    label: "Write operator reports",
    description:
      "The assistant can post operator-side reports back into Signal (notes, summaries).",
    scopes: ["reports:write"],
    defaultChecked: false,
  },
];

export function resolveScopesFromGroups(
  groupKeys: ReadonlyArray<string>,
): AllowedScope[] {
  const out = new Set<AllowedScope>();
  for (const key of groupKeys) {
    const group = FOUNDER_PERMISSION_GROUPS.find((g) => g.key === key);
    if (!group) continue;
    for (const scope of group.scopes) {
      out.add(scope);
    }
  }
  // Filter against ALLOWED_SCOPES so a typo in the group catalog
  // can't somehow surface a banned scope. Belt-and-suspenders.
  return [...out].filter((s) =>
    (ALLOWED_SCOPES as ReadonlyArray<string>).includes(s),
  );
}

/**
 * Reverse-map: given the scopes stored on an existing token, list the
 * founder-readable group labels the founder would tick to recreate it.
 * Used on the tokens list page to render "Read drafts and identities ·
 * Prepare drafts" instead of the raw scope strings.
 */
export function describeScopesAsGroups(
  scopes: ReadonlyArray<string>,
): string[] {
  const present = new Set(scopes);
  const out: string[] = [];
  for (const group of FOUNDER_PERMISSION_GROUPS) {
    if (group.scopes.every((s) => present.has(s))) {
      out.push(group.label);
    }
  }
  return out;
}
