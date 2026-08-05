import "server-only";
/**
 * Phase F4.6 — provider dispatcher.
 *
 * Priority order:
 *   1. SIGNAL_AI_PROVIDER = "anthropic" | "openai" (explicit override)
 *   2. ANTHROPIC_API_KEY if set
 *   3. OPENAI_API_KEY if set
 *   4. no provider configured → caller falls back to seed
 *
 * Single entry point: `callGenerationProvider(call)` returns a
 * normalized GenerationProviderResponse.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { callAnthropic } from "./anthropic";
import { callOpenAI } from "./openai";
import { checkWorkspaceAiUsage, usageLimitMessage } from "../usage-limit";
import type {
  GenerationProviderCall,
  GenerationProviderName,
  GenerationProviderResponse,
} from "./normalize-response";

export type { GenerationProviderCall, GenerationProviderResponse };

/**
 * Every provider call must declare which workspace it spends on.
 *
 * This parameter is REQUIRED, not optional, and that is the whole
 * point: the type system now refuses a provider call that is not
 * attributable to a budget. Before P0.5 the usage limit was checked in
 * two UI server actions and nowhere else, so the MCP planning tools —
 * which loop over identities x topics x weeks, one real provider call
 * per iteration — could spend without bound on the workspace's key.
 *
 * Metering happens HERE rather than in each caller so that any future
 * caller (a cron, a new tool, another action) is metered by
 * construction instead of by remembering.
 */
export interface GenerationMeteringContext {
  workspaceId: string;
  /**
   * Client used to read the usage ledger. UI callers omit it and get
   * the cookie-bound client; MCP passes its service-role client.
   */
  db?: SupabaseClient;
}

export function activeProvider(): GenerationProviderName | null {
  const explicit = process.env.SIGNAL_AI_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic" && process.env.ANTHROPIC_API_KEY?.trim()) {
    return "anthropic";
  }
  if (explicit === "openai" && process.env.OPENAI_API_KEY?.trim()) {
    return "openai";
  }
  // Default priority: Anthropic first when both are present — Signal's
  // own voice is closest to Claude's natural register.
  if (process.env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  return null;
}

export async function callGenerationProvider(
  call: GenerationProviderCall,
  meter: GenerationMeteringContext,
): Promise<GenerationProviderResponse> {
  // Budget check BEFORE provider selection and before any request is
  // dispatched, so a refusal never costs a token.
  //
  // `checkWorkspaceAiUsage` fails OPEN when the ledger itself cannot be
  // read. That is the pre-existing product rule ("never block a flow
  // because the usage helper failed") and it is deliberately preserved:
  // a transient database blip should not stop a founder from writing.
  const usage = await checkWorkspaceAiUsage(meter.workspaceId, meter.db);
  if (usage.exceeded) {
    return {
      ok: false,
      reason: "usage_limit_exceeded",
      detail: usageLimitMessage(usage),
    };
  }

  const provider = activeProvider();
  if (provider === "anthropic") return callAnthropic(call);
  if (provider === "openai") return callOpenAI(call);
  return {
    ok: false,
    reason: "no_provider_configured",
    detail:
      "No AI provider is configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the workspace environment.",
  };
}
