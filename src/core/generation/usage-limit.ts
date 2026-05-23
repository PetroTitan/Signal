import "server-only";
/**
 * Phase F4.6.1 — workspace-level AI usage limit.
 *
 * Counts AI-action events in a rolling 24-hour window per workspace
 * and returns whether the next action would exceed the limit.
 *
 * AI actions counted:
 *   - draft.generated   (from generateDraftAction)
 *   - draft.rewritten   (from rewriteDraftAction)
 *
 * Soft action `draft.rewrite_undone` is NOT counted — undo reverses
 * a previously-counted action and shouldn't penalize the founder.
 *
 * Default limit: 20 / workspace / 24h. Override with
 * SIGNAL_AI_ACTIONS_PER_DAY env var if higher cost ceiling is needed.
 *
 * Reuses the existing activity_events table — every successful AI
 * action already writes a row there, so no new schema is required.
 */

import { createSupabaseServerClient } from "@/lib/supabase";

const DEFAULT_LIMIT = 20;
const WINDOW_HOURS = 24;

export interface AiUsageState {
  limit: number;
  used: number;
  remaining: number;
  exceeded: boolean;
  /** ISO timestamp the oldest counted action ages out of the window. */
  retryAfter: string | null;
}

function readLimit(): number {
  const raw = process.env.SIGNAL_AI_ACTIONS_PER_DAY?.trim();
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  // Hard cap at 200 to prevent operator typo causing runaway burn.
  return Math.min(parsed, 200);
}

/**
 * Query the rolling 24h window for AI-action events and decide
 * whether the workspace can spend another one.
 *
 * Counts both successful and failed-but-billed actions: every
 * `draft.generated` and `draft.rewritten` event maps to a real
 * provider call (or a seeded fallback that also counts because it
 * exercised the same code path). The undo event is excluded.
 */
export async function checkWorkspaceAiUsage(
  workspaceId: string,
): Promise<AiUsageState> {
  const supabase = createSupabaseServerClient();
  const since = new Date(
    Date.now() - WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const limit = readLimit();

  const { data, error } = await supabase
    .from("activity_events")
    .select("created_at")
    .eq("workspace_id", workspaceId)
    .in("event_type", ["draft.generated", "draft.rewritten"])
    .gte("created_at", since)
    .order("created_at", { ascending: true });

  if (error) {
    // Fail open — never block a publish flow because the usage
    // helper itself failed. The activity event will still be
    // recorded by the action; next call will see the real count.
    return {
      limit,
      used: 0,
      remaining: limit,
      exceeded: false,
      retryAfter: null,
    };
  }

  const rows = (data ?? []) as Array<{ created_at: string }>;
  const used = rows.length;
  const exceeded = used >= limit;
  const oldest = rows[0]?.created_at ?? null;
  const retryAfter = exceeded && oldest
    ? new Date(
        new Date(oldest).getTime() + WINDOW_HOURS * 60 * 60 * 1000,
      ).toISOString()
    : null;

  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    exceeded,
    retryAfter,
  };
}

/**
 * Founder-readable message rendered when the limit is reached.
 * Calm wording — no "API quota exceeded" or "billing limit hit".
 */
export function usageLimitMessage(state: AiUsageState): string {
  if (!state.exceeded) return "";
  const hint = state.retryAfter
    ? ` Resets after ${new Date(state.retryAfter).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })}.`
    : " Try again tomorrow.";
  return `You've used today's AI writing limit.${hint} You can keep editing manually.`;
}
