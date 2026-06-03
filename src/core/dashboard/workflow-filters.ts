/**
 * Pure workflow-bucket filtering, sorting, pagination and counting for
 * the Dashboard Organization Pass.
 *
 * Background
 * ----------
 * Both the Dashboard ("This week") and the Weekly Plan render the SAME
 * underlying `weekly_plan_items` rows but slice them into operator-
 * facing workflow buckets (Queue / Scheduled / Published / Paused /
 * Failed). Centralizing that slicing here means the Dashboard sections
 * and the Weekly Plan tabs can never disagree about which item belongs
 * where, and the rules can be unit-tested without a database.
 *
 * Hard rules (mirrors the task constraints):
 *   - NO derived / fake statuses. Every bucket is decided from the
 *     REAL `weekly_plan_items.status` (plus real `risk_level` and
 *     real creative-review / failure flags the caller derives from
 *     other source-of-truth tables).
 *   - NO mutation of the underlying rows.
 *   - Pure module — no React, no I/O, no `server-only`.
 *
 * Out of scope: card chrome, table markup, schedule formatting.
 */

import type { RiskLevel, WeeklyPlanItemStatus } from "@/lib/supabase/types";

// =====================================================================
// Tabs
// =====================================================================

export type WorkflowTab =
  | "plan"
  | "queue"
  | "scheduled"
  | "published"
  | "paused"
  | "failed";

export interface WorkflowTabMeta {
  id: WorkflowTab;
  label: string;
  /** Short hint shown under the tab strip / as the section sub-copy. */
  hint: string;
}

/**
 * Canonical tab order + copy. `plan` leads because it is the familiar
 * editorial board (the default landing view); the focused status tabs
 * follow. `failed` is appended by the caller only when failed data
 * actually exists.
 */
export const WORKFLOW_TABS: readonly WorkflowTabMeta[] = [
  {
    id: "plan",
    label: "Plan",
    hint: "Everything in flight this week, grouped by day.",
  },
  {
    id: "queue",
    label: "Queue",
    hint: "Awaiting approval, approved & held, blocked, or needs creative review.",
  },
  {
    id: "scheduled",
    label: "Scheduled",
    hint: "Approved posts lined up to publish, nearest first.",
  },
  {
    id: "published",
    label: "Published",
    hint: "Already live. Newest first.",
  },
  {
    id: "paused",
    label: "Paused",
    hint: "On hold. Resume to bring back into the plan.",
  },
  {
    id: "failed",
    label: "Failed",
    hint: "The platform refused these. Open to see what happened.",
  },
] as const;

const TAB_IDS = new Set<string>(WORKFLOW_TABS.map((t) => t.id));

/**
 * Resolve a raw `?tab=` search param to a known tab, defaulting to
 * `plan`. Unknown / absent values fall back to the default so a stale
 * bookmark never renders an empty page.
 */
export function resolveWorkflowTab(raw: string | string[] | undefined): WorkflowTab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && TAB_IDS.has(value)) return value as WorkflowTab;
  return "plan";
}

// =====================================================================
// Item view — the minimal real-state shape the filters operate on
// =====================================================================

/**
 * Lifecycle states in which a `weekly_plan_items` row is "done" — the
 * editorial `scheduled_at` is now historical, not a future deadline.
 * Used to gate the relative "Due in / Overdue by" countdown so a
 * published item never shows an "Overdue" chip (the audit finding).
 */
const TERMINAL_STATUSES: ReadonlySet<WeeklyPlanItemStatus> = new Set([
  "published",
  "rejected",
  "backlog",
  "skipped",
]);

/**
 * In-flight states — still moving toward a publish. Only these are
 * eligible to be "blocked" or "needs creative review" in the Queue
 * (a published item with a stale blocked risk_level must NOT resurface
 * in the Queue).
 */
const IN_FLIGHT_STATUSES: ReadonlySet<WeeklyPlanItemStatus> = new Set([
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
]);

export interface WorkflowItemView {
  id: string;
  /** REAL weekly_plan_items.status — the only source of truth. */
  status: WeeklyPlanItemStatus;
  /** REAL weekly_plan_items.risk_level. */
  riskLevel: RiskLevel | null;
  /** Editorial scheduled_at (ISO) or null. */
  scheduledAt: string | null;
  /** Effective publish time used for ordering scheduled/published
   *  views (execution-item time when active, else editorial). */
  effectiveAt: string | null;
  /** weekly_plan_items.created_at (ISO) — Queue sorts oldest-first. */
  createdAt: string;
  /** Derived by caller from the primary creative's REAL status
   *  (`needs_review`). Not a fake status — a real creative-review
   *  signal surfaced for the Queue. */
  needsCreativeReview: boolean;
  /** Derived by caller from REAL execution_item / publish_history
   *  failed|blocked outcomes for this item. */
  hasFailure: boolean;
}

// =====================================================================
// Bucket predicates — each grounded in real DB state
// =====================================================================

export function isTerminalStatus(status: WeeklyPlanItemStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Queue = work that needs an operator decision before it can publish:
 *   - awaiting approval        (status pending_approval)
 *   - approved & hold          (status approved, not yet scheduled)
 *   - blocked approval state   (in-flight + risk_level "blocked")
 *   - needs creative review    (in-flight + creative needs_review)
 *
 * Terminal items are never in the Queue even if they carry a stale
 * blocked risk_level.
 */
export function isQueueItem(v: WorkflowItemView): boolean {
  if (v.status === "pending_approval") return true;
  if (v.status === "approved") return true;
  if (!IN_FLIGHT_STATUSES.has(v.status)) return false;
  if (v.riskLevel === "blocked") return true;
  if (v.needsCreativeReview) return true;
  return false;
}

/**
 * Awaiting Approval (Dashboard section) = the subset of the Queue that
 * still needs an approval decision or is held back by a blocker:
 *   - awaiting approval      (status pending_approval)
 *   - blocked approval state (in-flight + risk_level "blocked")
 *   - needs creative review  (in-flight + creative needs_review)
 *
 * Narrower than {@link isQueueItem}: it deliberately EXCLUDES
 * `approved` ("approved & hold"), since those have already cleared
 * approval and are simply waiting to be scheduled.
 */
export function isAwaitingApprovalItem(v: WorkflowItemView): boolean {
  if (v.status === "pending_approval") return true;
  if (!IN_FLIGHT_STATUSES.has(v.status)) return false;
  if (v.riskLevel === "blocked") return true;
  if (v.needsCreativeReview) return true;
  return false;
}

/**
 * Scheduled = REAL status `scheduled`. These are the approved posts the
 * scheduler will fire. We keep every scheduled item (including any with
 * a past time that is about to fire / stuck) rather than hiding them —
 * hiding actionable work would defeat the purpose. Ordering is nearest
 * publish-time first via {@link compareScheduledAsc}.
 */
export function isScheduledItem(v: WorkflowItemView): boolean {
  return v.status === "scheduled";
}

export function isPublishedItem(v: WorkflowItemView): boolean {
  return v.status === "published";
}

export function isPausedItem(v: WorkflowItemView): boolean {
  return v.status === "paused";
}

/**
 * Failed = a REAL failed/blocked execution or publish outcome exists
 * for this item. There is no `failed` weekly_plan_items status, so this
 * flag is derived by the caller from execution_items / publish_history
 * (no invented status).
 */
export function isFailedItem(v: WorkflowItemView): boolean {
  return v.hasFailure;
}

/**
 * Items shown on the default "Plan" board: everything still in flight,
 * i.e. NOT terminal. Published / rejected / backlog / skipped drop out
 * of the editorial stream (published moves to its own tab) so the board
 * stops being dominated by history. Paused stays visible here because
 * it is still part of the active plan.
 */
export function isPlanBoardItem(v: WorkflowItemView): boolean {
  return !isTerminalStatus(v.status);
}

/**
 * Should the relative "Due in / Overdue by" countdown render for an
 * item in this lifecycle status?
 *
 * Audit fix: the countdown is only meaningful while an item is still
 * waiting to publish. For terminal states the `scheduled_at` is the
 * historical publish/editorial time, NOT a deadline — rendering
 * "Overdue by X days" next to a "Published" badge is the bug. We keep
 * the timestamp itself (real DB state) but drop the deadline framing.
 */
export function shouldShowDueCountdown(status: WeeklyPlanItemStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
}

// =====================================================================
// Sorting
// =====================================================================

function timeOrInfinity(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function timeOrNegInfinity(iso: string | null): number {
  if (!iso) return Number.NEGATIVE_INFINITY;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** Queue + Awaiting Approval: oldest first (by created_at). */
export function compareOldestFirst(
  a: Pick<WorkflowItemView, "createdAt">,
  b: Pick<WorkflowItemView, "createdAt">,
): number {
  return timeOrInfinity(a.createdAt) - timeOrInfinity(b.createdAt);
}

/** Scheduled: nearest publish time first (effective time ascending). */
export function compareScheduledAsc(
  a: Pick<WorkflowItemView, "effectiveAt">,
  b: Pick<WorkflowItemView, "effectiveAt">,
): number {
  return timeOrInfinity(a.effectiveAt) - timeOrInfinity(b.effectiveAt);
}

/** Published / Recent Activity: most recent first. */
export function comparePublishedDesc(
  a: Pick<WorkflowItemView, "effectiveAt">,
  b: Pick<WorkflowItemView, "effectiveAt">,
): number {
  return timeOrNegInfinity(b.effectiveAt) - timeOrNegInfinity(a.effectiveAt);
}

// =====================================================================
// Status counts — Summary cards (DB source-of-truth, no fudging)
// =====================================================================

export interface SummaryCounts {
  published: number;
  scheduled: number;
  awaitingApproval: number;
  paused: number;
}

/**
 * Direct counts of the REAL `weekly_plan_items.status`. Each card maps
 * 1:1 to a single status value — there is no derived arithmetic, so the
 * numbers always match a naive `GROUP BY status` over the same rows.
 */
export function summaryCounts(
  items: ReadonlyArray<Pick<WorkflowItemView, "status">>,
): SummaryCounts {
  let published = 0;
  let scheduled = 0;
  let awaitingApproval = 0;
  let paused = 0;
  for (const it of items) {
    switch (it.status) {
      case "published":
        published += 1;
        break;
      case "scheduled":
        scheduled += 1;
        break;
      case "pending_approval":
        awaitingApproval += 1;
        break;
      case "paused":
        paused += 1;
        break;
      default:
        break;
    }
  }
  return { published, scheduled, awaitingApproval, paused };
}

// =====================================================================
// Pagination
// =====================================================================

export interface Paginated<T> {
  /** 1-based clamped page actually shown. */
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: T[];
  hasPrev: boolean;
  hasNext: boolean;
  /** 1-based index of the first item on this page (0 when empty). */
  startIndex: number;
  /** 1-based index of the last item on this page (0 when empty). */
  endIndex: number;
}

export const DEFAULT_PAGE_SIZE = 20;

/**
 * In-memory pagination over an already-ordered array. Page is clamped
 * into `[1, totalPages]` so an out-of-range `?page=` never renders an
 * empty page. The rows themselves are already loaded by the page; this
 * only limits what gets rendered (the Published-history dominance fix).
 */
export function paginate<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Paginated<T> {
  const size = Math.max(1, Math.floor(pageSize));
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (safePage - 1) * size;
  const end = Math.min(start + size, total);
  return {
    page: safePage,
    pageSize: size,
    total,
    totalPages,
    items: rows.slice(start, end),
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    startIndex: total === 0 ? 0 : start + 1,
    endIndex: end,
  };
}

/** Parse a raw `?page=` value to a positive integer (default 1). */
export function parsePageParam(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

// =====================================================================
// Published / Failed table search
// =====================================================================

export interface PublishedSearchable {
  title: string | null;
  platform: string | null;
  subreddit: string | null;
}

/** Normalize a raw `?q=` value to a trimmed string ("" when absent). */
export function parseSearchQuery(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").trim();
}

/**
 * Case-insensitive substring match across title / platform / subreddit.
 * An empty query returns the rows unchanged. Pure — used by the compact
 * Published + Failed tables.
 */
export function searchPublishedRows<T extends PublishedSearchable>(
  rows: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((r) => {
    const haystack = [r.title, r.platform, r.subreddit]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}
