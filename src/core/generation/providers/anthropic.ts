import "server-only";
/**
 * Phase F4.6 — Anthropic Messages API client.
 *
 * Plain `fetch` against
 *   POST https://api.anthropic.com/v1/messages
 *
 * Headers:
 *   x-api-key: <ANTHROPIC_API_KEY>
 *   anthropic-version: 2023-06-01
 *   content-type: application/json
 *
 * Body:
 *   {
 *     model: <model>,
 *     max_tokens: <int>,
 *     system: <system prompt>,
 *     messages: [{ role: "user", content: <user prompt> }]
 *   }
 *
 * Response shape (success):
 *   {
 *     content: [{ type: "text", text: "..." }, ...],
 *     stop_reason: "end_turn" | "max_tokens" | "stop_sequence",
 *     ...
 *   }
 *
 * NEVER:
 *   - logs the API key
 *   - logs the prompt body
 *   - returns raw response bodies in error states
 *   - retries automatically
 */

import type {
  GenerationProviderCall,
  GenerationProviderResponse,
} from "./normalize-response";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-5";

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  model?: string;
}

export async function callAnthropic(
  call: GenerationProviderCall,
): Promise<GenerationProviderResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      reason: "no_credentials",
      detail: "ANTHROPIC_API_KEY is not configured.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs ?? 30_000);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
        max_tokens: call.maxOutputTokens ?? 4096,
        system: call.system,
        messages: [{ role: "user", content: call.user }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted =
      err instanceof Error &&
      (err.name === "AbortError" || err.message.includes("aborted"));
    return {
      ok: false,
      reason: aborted ? "timeout" : "network_error",
      detail: aborted
        ? "Anthropic didn't respond within the timeout."
        : "Couldn't reach Anthropic — check the network.",
      durationMs: Date.now() - startedAt,
    };
  }
  clearTimeout(timer);
  const durationMs = Date.now() - startedAt;

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      reason: "unauthorized",
      detail:
        "Anthropic rejected the API key. Re-add the key or check the workspace it belongs to.",
      durationMs,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      detail: "Anthropic asked us to slow down. Try again in a moment.",
      durationMs,
    };
  }
  if (response.status === 529) {
    return {
      ok: false,
      reason: "overloaded",
      detail: "Claude is overloaded right now. Try again in a moment.",
      durationMs,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `Claude returned an unexpected response (HTTP ${response.status}).`,
      durationMs,
    };
  }

  let json: AnthropicMessagesResponse;
  try {
    json = (await response.json()) as AnthropicMessagesResponse;
  } catch {
    return {
      ok: false,
      reason: "provider_error",
      detail: "Couldn't read Claude's response.",
      durationMs,
    };
  }

  const text =
    (json.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim() || null;

  if (!text || text.length === 0) {
    return {
      ok: false,
      reason: "empty_response",
      detail: "Claude returned an empty response.",
      durationMs,
    };
  }

  if (json.stop_reason === "max_tokens") {
    return {
      ok: true,
      text,
      providerName: "anthropic",
      truncated: true,
      durationMs,
    };
  }

  return {
    ok: true,
    text,
    providerName: "anthropic",
    truncated: false,
    durationMs,
  };
}
