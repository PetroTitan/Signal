/**
 * UI / read-model parity helper for /weekly-plan.
 *
 * Pre-fix `page.tsx` built `creativeByItem` with a "first row wins"
 * loop over the result of `listCreativesForItems`:
 *
 *   const creativeByItem = new Map<string, Creative>();
 *   for (const c of creatives) {
 *     if (!creativeByItem.has(c.weeklyPlanItemId)) {
 *       creativeByItem.set(c.weeklyPlanItemId, c);
 *     }
 *   }
 *
 * The MCP read tool `signal.weekly_plan.current` already groups by
 * `weekly_plan_item_id` and picks the primary creative with the
 * shared asset-aware selector `selectPrimaryCreative` (see
 * `src/core/publishing/creative-readiness.ts`). The UI MUST use
 * the same selector so the rendered "current creative" matches
 * what MCP returns — otherwise operators see a stale legacy /
 * placeholder creative on the page while Codex / publishers act
 * on the real uploaded one.
 *
 * This module is pure (no I/O) so it can be unit-tested without
 * the Supabase client.
 */

import {
  selectPrimaryCreative,
  type SelectableCreative,
} from "@/core/publishing/creative-readiness";
import type { WeeklyPlanItemCreative } from "@/repositories/weekly-plan-creative-repository";

/**
 * Group `creatives` by `weeklyPlanItemId` and pick the primary
 * creative per item using the shared `selectPrimaryCreative`
 * selector (presence tier → status → newest createdAt).
 *
 * The map's values are the ORIGINAL `WeeklyPlanItemCreative` rows
 * so downstream UI (`PlanItemCard`, `CreativeCard`, approval
 * controls) keeps the exact same shape it always had.
 */
export function selectPrimaryCreativeByItem(
  creatives: ReadonlyArray<WeeklyPlanItemCreative>,
): Map<string, WeeklyPlanItemCreative> {
  type Candidate = SelectableCreative & { row: WeeklyPlanItemCreative };
  const byItem = new Map<string, Candidate[]>();
  for (const c of creatives) {
    const candidate: Candidate = {
      id: c.id,
      createdAt: c.createdAt,
      status: c.status,
      sourceType: c.sourceType,
      assetUrl: c.assetUrl,
      sourceUrl: c.sourceUrl,
      storagePath: c.storagePath,
      altText: c.altText,
      prompt: c.prompt,
      license: c.license,
      attribution: c.attribution,
      row: c,
    };
    const bucket = byItem.get(c.weeklyPlanItemId);
    if (bucket) {
      bucket.push(candidate);
    } else {
      byItem.set(c.weeklyPlanItemId, [candidate]);
    }
  }
  const out = new Map<string, WeeklyPlanItemCreative>();
  for (const [itemId, candidates] of byItem) {
    const winner = selectPrimaryCreative(candidates);
    if (winner) out.set(itemId, winner.row);
  }
  return out;
}
