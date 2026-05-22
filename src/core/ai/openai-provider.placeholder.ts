import type { AiProvider, AiResult } from "./ai-provider";
import type { AiUseCase } from "./ai-use-cases";
import type { AiInputFor } from "./prompt-contracts";
import { aiError } from "./ai-errors";

/**
 * OpenAI provider placeholder.
 *
 * This file intentionally does NOT import the OpenAI SDK and does NOT
 * make network requests. It exists so the surrounding architecture has
 * a typed seat for the future real provider.
 *
 * When the integration ships:
 *   - The OpenAI client is instantiated server-side, never in the browser.
 *   - API keys are loaded from server environment variables.
 *   - This module exposes the same AiProvider interface.
 *   - The UI continues to call the provider through src/core/ai/ai-provider.ts.
 */
export class OpenAiProviderPlaceholder implements AiProvider {
  readonly meta = {
    id: "openai_placeholder",
    label: "OpenAI",
    mode: "openai" as const,
    connected: false,
    notes: [
      "Not implemented yet.",
      "Will be configured securely on the server.",
      "No API key is ever read in the browser.",
    ],
  };

  async generate<U extends AiUseCase>(
    _useCase: U,
    _input: AiInputFor<U>,
  ): Promise<AiResult<U>> {
    return {
      ok: false,
      error: aiError(
        "provider_not_connected",
        "OpenAI provider is a placeholder; no client is wired.",
      ),
    };
  }
}
