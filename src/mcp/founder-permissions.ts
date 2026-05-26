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

/**
 * Sentinel group key. NOT a real `FounderPermissionGroup` entry —
 * the token action expands `full_access` into every entry in
 * `ALLOWED_SCOPES` (and only into ALLOWED_SCOPES — blocked scopes
 * are a separate list and cannot leak through this expansion).
 *
 * Kept as a constant so tests + the UI use the same source of truth.
 */
export const FULL_ACCESS_GROUP_KEY = "full_access";

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
    label: "Modify pending weekly plan items",
    description:
      "The assistant can create new drafts and update pending/draft items in your weekly plan, including the scheduled time. Items still land as draft / pending — you approve before publishing.",
    scopes: ["weekly_plans:write_pending"],
    defaultChecked: true,
  },
  {
    key: "schedule_publishing",
    label: "Schedule publishing",
    description:
      "The assistant can schedule approved plan items for publishing through Signal's scheduler. Does not bypass approval and does not call any platform API itself.",
    scopes: ["weekly_plans:read", "execution:read", "execution:schedule"],
    defaultChecked: false,
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
  // `full_access` is the only sentinel — it expands to every entry
  // in ALLOWED_SCOPES and short-circuits the rest of the loop.
  // BLOCKED_SCOPES are NOT in ALLOWED_SCOPES, so full_access cannot
  // grant them even by accident.
  if (groupKeys.includes(FULL_ACCESS_GROUP_KEY)) {
    return [...ALLOWED_SCOPES];
  }
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
 * Recommended preset list. UI-only — pre-selects a set of groups
 * the operator can apply with one click. Presets never grant scopes
 * that wouldn't already be granted by the underlying groups; they're
 * a UX affordance, not a privilege escalation.
 */
export interface FounderPermissionPreset {
  key: string;
  label: string;
  description: string;
  groupKeys: readonly string[];
}

export const FOUNDER_PERMISSION_PRESETS: ReadonlyArray<FounderPermissionPreset> =
  [
    {
      key: "codex_full_workflow",
      label: "Codex / Claude full workflow",
      description:
        "Everything the assistant needs for the end-to-end scheduled publishing flow: read, prepare drafts, schedule publishing, review history, dry-run.",
      groupKeys: [
        "read_workspace",
        "prepare_drafts",
        "schedule_publishing",
        "review_publishing_history",
        "dry_run_execution",
      ],
    },
  ];

/**
 * Reverse-map a list of missing scopes to the founder-readable
 * groups that would grant them. The dispatcher's unauthorized
 * response uses this to suggest which permission box(es) to enable
 * rather than handing the operator raw scope strings.
 *
 * Returns deduplicated group labels in the order groups appear in
 * FOUNDER_PERMISSION_GROUPS (deterministic UX).
 */
export function suggestGroupsForMissingScopes(
  missingScopes: ReadonlyArray<string>,
): FounderPermissionGroup[] {
  const need = new Set(missingScopes);
  const seen = new Set<string>();
  const out: FounderPermissionGroup[] = [];
  for (const group of FOUNDER_PERMISSION_GROUPS) {
    if (seen.has(group.key)) continue;
    if (group.scopes.some((s) => need.has(s))) {
      out.push(group);
      seen.add(group.key);
    }
  }
  return out;
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
