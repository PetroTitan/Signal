import "server-only";
/**
 * The two-line advisory read, for surfaces whose job is something else.
 *
 * The weekly plan and the compose sheet exist to write, approve and
 * schedule. Strategy appears there as a hint and nothing more, so this
 * helper returns at most a couple of options and swallows every failure:
 * if the strategy layer cannot load, the composer must still open. A
 * publishing surface that breaks because an advisory read failed would
 * have made advice load-bearing, which is exactly the inversion this
 * milestone exists to avoid.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StrategyHint } from "@/components/strategy-hints";
import { loadStrategy } from "./load-strategy.server";

/** Deliberately small: this is a hint, not the dashboard. */
export const MAX_HINTS = 2;

export async function loadStrategyHints(
  workspaceId: string,
  options: { db?: SupabaseClient; limit?: number } = {},
): Promise<StrategyHint[]> {
  try {
    const view = await loadStrategy(workspaceId, new Date().toISOString(), {
      db: options.db,
    });
    if (view.empty) return [];
    return view.recommendations.slice(0, options.limit ?? MAX_HINTS).map((option) => ({
      id: option.id,
      title: option.title,
      rationale: option.rationale,
    }));
  } catch {
    // Silent by design. There is no operator action attached to "the
    // hint strip could not load", and surfacing an error banner on the
    // composer would be worse than showing nothing.
    return [];
  }
}
