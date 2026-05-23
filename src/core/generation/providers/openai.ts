import "server-only";
/**
 * Phase F4.6 — OpenAI Chat Completions client.
 *
 * Plain `fetch` against
 *   POST https://api.openai.com/v1/chat/completions
 *
 * Headers:
 *   Authorization: Bearer <OPENAI_API_KEY>
 *   content-type: application/json
 *
 * Body:
 *   {
 *     model: <model>,
 *     messages: [
 *       { role: "system", content: <system prompt> },
 *       { role: "user", content: <user prompt> }
 *     ],
 *     max_tokens: <int>
 *   }
 *
 * Response shape (success):
 *   {
 *     choices: [{
 *       message: { role: "assistant", content: "..." },
 *       finish_reason: "stop" | "length" | ...
 *     }],
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

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o";

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  model?: string;
}

export async function callOpenAI(
  call: GenerationProviderCall,
): Promise<GenerationProviderResponse> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      reason: "no_credentials",
      detail: "OPENAI_API_KEY is not configured.",
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
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
        max_tokens: call.maxOutputTokens ?? 4096,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
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
        ? "OpenAI didn't respond within the timeout."
        : "Couldn't reach OpenAI — check the network.",
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
        "OpenAI rejected the API key. Re-add the key or check the org it belongs to.",
      durationMs,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      reason: "rate_limited",
      detail: "OpenAI asked us to slow down. Try again in a moment.",
      durationMs,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "provider_error",
      detail: `OpenAI returned an unexpected response (HTTP ${response.status}).`,
      durationMs,
    };
  }

  let json: OpenAiChatResponse;
  try {
    json = (await response.json()) as OpenAiChatResponse;
  } catch {
    return {
      ok: false,
      reason: "provider_error",
      detail: "Couldn't read OpenAI's response.",
      durationMs,
    };
  }

  const choice = (json.choices ?? [])[0];
  const text = choice?.message?.content?.trim() || null;
  if (!text) {
    return {
      ok: false,
      reason: "empty_response",
      detail: "OpenAI returned an empty response.",
      durationMs,
    };
  }

  return {
    ok: true,
    text,
    providerName: "openai",
    truncated: choice?.finish_reason === "length",
    durationMs,
  };
}
