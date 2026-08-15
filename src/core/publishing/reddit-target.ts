/**
 * Reddit routing target — the canonical source, and how it travels.
 *
 * The defect this module closes
 * -----------------------------
 * The operator types a subreddit in the editor; it is persisted at
 * `weekly_plan_items.metadata.target`. The scheduler reads
 * `execution_items.metadata.target`. Nothing ever copied one to the
 * other — none of the four `createExecutionItem` call sites included
 * it — so `resolveSchedulerTarget` returned null for every scheduled
 * Reddit item and the runner refused with `missing_subreddit`:
 * terminal `failed`, plan item `paused`, every time.
 *
 * That the product still publishes to Reddit at all is because the
 * manual path is form-driven: `/execution/items/[id]` reads the
 * subreddit from the submitted form and calls `publishToReddit`
 * directly, never consulting metadata. So the autonomous path has been
 * dead, not merely degraded.
 *
 * Why a dedicated module
 * ----------------------
 * The copy has to happen at four call sites, and a fifth added later
 * would silently reopen the defect. One helper, spread into each
 * metadata literal, plus a static test asserting every call site uses
 * it, is what makes that unrepresentable.
 *
 * Why it is gated on `allowsOperatorTarget`
 * -----------------------------------------
 * `resolveSchedulerTarget` reads `metadata.target` with HIGHER
 * precedence than the identity's own `provider_account_id`. Copying it
 * unconditionally would therefore not "also help Telegram" — it would
 * override the connected chat id with whatever string the item
 * happened to carry. Only Reddit takes an operator-typed target.
 *
 * Pure. No I/O. Safe on both server and client.
 */

import { allowsOperatorTarget } from "./publish-destinations";

/**
 * Canonical form of a subreddit name: trimmed, `r/` or `/r/` prefix
 * removed. Case is preserved — Reddit subreddit names are
 * case-insensitive for routing but display with their real casing, and
 * the value is sent verbatim as the `sr` parameter.
 *
 * The prefix strip matters: `publish-reddit.ts` sends the value
 * straight through to `sr=`, so an operator who typed "r/test" would
 * otherwise have produced `sr=r/test` and a provider-side error.
 */
export function normalizeSubreddit(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/^\/?r\//i, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Read the operator-typed routing target off a plan item's metadata.
 * Returns null for every platform that does not take one.
 */
export function readOperatorTarget(
  platform: string | null | undefined,
  planItemMetadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!allowsOperatorTarget(platform)) return null;
  return normalizeSubreddit(
    (planItemMetadata as { target?: unknown } | null | undefined)?.target as
      | string
      | undefined,
  );
}

/**
 * The fragment to spread into an `execution_items.metadata` literal.
 *
 * Returns `{}` — not `{ target: null }` — when there is nothing to
 * carry, so the key is simply absent rather than present-and-null. The
 * scheduler treats a non-string as absent either way, but an absent key
 * keeps the audit metadata honest about what the item actually knows.
 *
 * Spread it, never assign it:
 *
 *     metadata: {
 *       plan_item_id: item.id,
 *       ...executionTargetMetadata(item.platform, item.metadata),
 *     }
 */
export function executionTargetMetadata(
  platform: string | null | undefined,
  planItemMetadata: Record<string, unknown> | null | undefined,
): { target: string } | Record<string, never> {
  const target = readOperatorTarget(platform, planItemMetadata);
  return target === null ? {} : { target };
}

/**
 * Approval-time refusal for a destination that needs an operator-typed
 * target and has none. Returns null when there is nothing to refuse.
 *
 * This exists so the operator is told at approval time rather than
 * discovering it as a terminal publish failure they then have to
 * recover from. It is the fail-closed half of this fix: threading the
 * target without it would just move `missing_subreddit` later.
 */
export function operatorTargetBlocker(
  platform: string | null | undefined,
  planItemMetadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!allowsOperatorTarget(platform)) return null;
  if (readOperatorTarget(platform, planItemMetadata) !== null) return null;
  return "Reddit posts need a target subreddit. Add one in the editor before scheduling.";
}
