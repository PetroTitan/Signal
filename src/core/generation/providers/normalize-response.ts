/**
 * Phase F4.6 — provider response shape.
 *
 * Both Anthropic and OpenAI return different JSON shapes, different
 * error codes, and different "we hit the max tokens" signals.
 * `GenerationProviderResponse` is the single internal shape both
 * provider modules return, so the dispatcher and the calling code
 * never have to switch on provider name.
 *
 * Reasons are pure enum strings; the founder-readable mapping lives
 * in `friendlyGenerationFailure` in src/core/generation/founder-error.ts.
 */

export type GenerationProviderName = "anthropic" | "openai";

export interface GenerationProviderCall {
  system: string;
  user: string;
  /** Optional token budget. Defaults differ per provider. */
  maxOutputTokens?: number;
  /** Optional override; default 30s. */
  timeoutMs?: number;
}

export type GenerationProviderResponse =
  | {
      ok: true;
      text: string;
      providerName: GenerationProviderName;
      truncated: boolean;
      durationMs: number;
    }
  | {
      ok: false;
      reason:
        | "no_credentials"
        | "unauthorized"
        | "rate_limited"
        | "overloaded"
        | "timeout"
        | "network_error"
        | "provider_error"
        | "empty_response"
        | "no_provider_configured";
      detail: string;
      durationMs?: number;
    };
