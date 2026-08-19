import "server-only";
/**
 * The optional provider call behind the strategy interpretation.
 *
 * Everything meaningful is decided before and after this call: the
 * evidence is deterministic, and the output is validated against it. The
 * call itself is thin on purpose.
 *
 * Metered through the same boundary as every other provider call, so a
 * strategy page cannot spend outside the workspace's budget. When no
 * provider is configured — the common case — this returns a rejection
 * immediately and costs nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { activeProvider, callGenerationProvider } from "@/core/generation/providers";
import {
  buildInterpretationPrompt,
  validateInterpretation,
  type InterpretationEvidence,
  type InterpretationResult,
} from "./ai-interpretation";

export async function interpretStrategy(
  evidence: InterpretationEvidence,
  context: { workspaceId: string; db?: SupabaseClient },
): Promise<InterpretationResult> {
  if (!activeProvider()) {
    return {
      ok: false,
      reason: "no_provider",
      detail: "No AI provider is configured for this deployment.",
    };
  }
  if (evidence.statements.length === 0) {
    // Nothing deterministic to restate. Calling anyway would be asking
    // the model to produce content from nothing, which is precisely the
    // input that makes models invent.
    return {
      ok: false,
      reason: "empty",
      detail: "There is no evidence to interpret yet.",
    };
  }

  const prompt = buildInterpretationPrompt(evidence);

  const response = await callGenerationProvider(
    {
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: 500,
      timeoutMs: 20_000,
    },
    { workspaceId: context.workspaceId, db: context.db },
  );

  if (!response.ok) {
    return {
      ok: false,
      reason: "provider_error",
      // The provider's own detail is not surfaced: it can carry request
      // context, and the operator's decision is the same either way.
      detail: "The interpretation could not be generated this time.",
    };
  }

  return validateInterpretation(response.text, prompt.allowedNumbers);
}
