/**
 * Shared approval-readiness types + pure UI helpers.
 *
 * THIS MODULE MUST STAY CLIENT-SAFE.
 *
 * Rules — enforced by approval-readiness-import-integrity.test.ts:
 *   - no `import "server-only"`
 *   - no imports from `@/repositories/*` (those carry server-only)
 *   - no imports from server actions
 *   - no Supabase client
 *   - only type-only imports from server modules when unavoidable
 *
 * If you find yourself reaching for `creativeReadinessReason` or
 * `WeeklyPlanItemCreative` from the creative repository: stop. Either
 * (a) inline a narrow type/local function, or (b) move the call into
 * `approval-readiness.server.ts` and have the server hand a plain
 * shape to the UI.
 */

// =====================================================================
// Result + status types — shared between server assessment and UI.
// =====================================================================

export interface ApprovalReadinessOkFlags {
  statusPending: boolean;
  riskNotBlocked: boolean;
  /**
   * Phase F7.4 — replaces the legacy `contentTypePost` flag. True
   * when the platform-native approval policy recognizes the item's
   * (platform, content_type, intent) as a publishable object.
   * Articles, threads, media posts, link posts, carousels, replies,
   * channel/group messages, video posts, community posts etc. all
   * pass. Unknown / malformed types fail with neutral copy.
   */
  approvableObject: boolean;
  creativeReady: boolean;
  contractActive: boolean;
  accountScope: boolean;
  productScope: boolean;
  platformScope: boolean;
  scheduleSet: boolean;
  /**
   * Phase F7.3 — true when the platform-native approval policy says
   * a creative is REQUIRED for this item's (platform, intent). When
   * false, the assessor skips the creative blocker entirely and the
   * UI shows neutral informational copy instead of a red blocker.
   */
  creativeRequired: boolean;
}

export interface ApprovalReadiness {
  /** True when all required blockers are clear for the path. */
  ready: boolean;
  /** Concrete blockers in operator-readable copy. Order is stable
   *  across calls so the UI can render them deterministically. */
  blockers: ReadonlyArray<string>;
  /**
   * Phase F7.3 — non-blocking notes the UI MAY surface alongside
   * blockers. Today populated with a "Creative optional for this
   * platform/format." message when the platform-native policy says
   * creative is optional and none is attached. Strictly additive —
   * existing consumers that ignore this field keep working.
   */
  informational: ReadonlyArray<string>;
  /** Structured breakdown — UI uses this to render affordances. */
  ok: ApprovalReadinessOkFlags;
}

/**
 * Narrow shape needed by the creative-state describer.
 * Both `WeeklyPlanItemCreative` (server repo) and `CreativeCardData`
 * (UI surface) satisfy this — UI components pass whichever they have.
 */
export interface CreativeStateFields {
  status: string;
  sourceType: string;
  assetUrl: string | null;
  sourceUrl: string | null;
  altText: string | null;
}

// =====================================================================
// Pure helpers
// =====================================================================

/**
 * Operator-facing one-liner summarizing what the post is awaiting.
 *
 * "Ready for post approval." when ready.
 * Otherwise: the first blocker, with "(+N more)" when there are
 * additional ones.
 */
export function summarizeReadiness(readiness: ApprovalReadiness): string {
  if (readiness.ready) return "Ready for post approval.";
  const first = readiness.blockers[0] ?? "Not ready for approval.";
  const extra =
    readiness.blockers.length > 1
      ? ` (+${readiness.blockers.length - 1} more)`
      : "";
  return `${first}${extra}`;
}

/**
 * UI helper — short human label for the "Creative status" sub-row of
 * the card. Independent of post status so the operator can see at a
 * glance which side still needs work.
 */
export function describeCreativeState(
  creative: CreativeStateFields | null,
): { label: string; tone: "ok" | "needs_review" | "missing" | "blocked" } {
  if (!creative) return { label: "No creative", tone: "missing" };
  if (creative.status === "rejected")
    return { label: "Creative rejected", tone: "blocked" };
  if (
    !creative.assetUrl &&
    !creative.sourceUrl &&
    creative.sourceType !== "planned"
  ) {
    return { label: "Creative missing asset", tone: "missing" };
  }
  if (creative.sourceType === "planned") {
    return { label: "Creative planned (no asset yet)", tone: "missing" };
  }
  if (!creative.altText || creative.altText.trim().length === 0) {
    return { label: "Alt text missing", tone: "needs_review" };
  }
  if (creative.status === "approved") {
    return { label: "Creative approved", tone: "ok" };
  }
  return { label: "Creative pending review", tone: "needs_review" };
}

/**
 * Maps the creative-readiness reason code (computed by the server
 * repository's `creativeReadinessReason`) to operator-readable copy.
 *
 * Pure — does NOT depend on the server function. The server module
 * computes the code and passes it here for human formatting, so the
 * UI can re-use this if it ever has the code in hand.
 */
export type CreativeReadinessCode =
  | "creative_missing"
  | "creative_missing_asset"
  | "creative_missing_alt_text"
  | "creative_not_approved"
  | "creative_rejected"
  | "creative_only_planned"
  | "creative_missing_license_or_attribution"
  | "creative_missing_prompt";

export function creativeBlockerCopy(
  code: CreativeReadinessCode | null,
): string {
  switch (code) {
    case "creative_missing":
      return "Creative is missing. Upload an asset or generate one.";
    case "creative_missing_asset":
      return "Creative has no asset URL. Re-upload or attach a URL.";
    case "creative_missing_alt_text":
      return "Alt text is required before approval and publishing.";
    case "creative_not_approved":
      return "This post cannot be approved yet because the attached creative is still pending review. Approve or reject the creative first.";
    case "creative_rejected":
      return "Creative was rejected. Replace it before approval.";
    case "creative_only_planned":
      return "Creative is only planned — attach the actual asset.";
    case "creative_missing_license_or_attribution":
      return "Creative needs license + attribution for this source type.";
    case "creative_missing_prompt":
      return "Generated creative needs a prompt recorded.";
    default:
      return "Creative is not ready.";
  }
}
