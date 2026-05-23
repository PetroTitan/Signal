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

import { callAnthropic } from "./anthropic";
import { callOpenAI } from "./openai";
import type {
  GenerationProviderCall,
  GenerationProviderName,
  GenerationProviderResponse,
} from "./normalize-response";

export type { GenerationProviderCall, GenerationProviderResponse };

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
): Promise<GenerationProviderResponse> {
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
