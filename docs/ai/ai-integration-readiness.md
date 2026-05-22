# AI integration readiness

Signal is designed to integrate AI eventually. Today, no real AI API is wired. This document describes the architecture that's already in place so the future integration is a small, safe change — not a rewrite.

## What ships today

- A typed `AiProvider` interface ([src/core/ai/ai-provider.ts](../../src/core/ai/ai-provider.ts)).
- A deterministic mock provider ([src/core/ai/mock-ai-provider.ts](../../src/core/ai/mock-ai-provider.ts)). It runs entirely in the browser, delegates to the existing engines (softening, conversion, summarization), and returns structured outputs that match the prompt contracts.
- An OpenAI placeholder ([src/core/ai/openai-provider.placeholder.ts](../../src/core/ai/openai-provider.placeholder.ts)) — no SDK import, no network. Exists so the seat is named.
- Typed prompt contracts and structured output shapes.
- Hard-coded use case allow-list and block-list.
- A safety policy with quick text-level checks.
- A cost policy that documents the limits the future system must respect.
- Error and telemetry types.

## What does not ship today

- No real OpenAI client.
- No `OPENAI_API_KEY` usage in runtime.
- No background loops, no autonomous loops, no auto-publishing.
- No API key collection in the browser.
- No environment variables required.

## How the future integration lands

1. Configure the OpenAI client **server-side** (Next.js Route Handler or Server Action). The browser never sees the key.
2. Replace `OpenAiProviderPlaceholder.generate()` body with a `fetch` to the server endpoint.
3. The server endpoint:
   - Receives `(useCase, input)`.
   - Validates against `AI_CONTRACTS`.
   - Calls the LLM with a tightly scoped prompt.
   - Validates the structured output.
   - Runs `quickSafetyCheck` on the output.
   - Returns `AiResult<U>`.
4. Flip the active provider via a server-side setting; the UI continues to call `getActiveAiProvider()`.

## Why local preview today

The mock provider keeps the entire app testable without external dependencies. It also makes the failure mode honest: when the UI says "Local preview mode," it means the output came from deterministic local logic, not an LLM.

## Voice in the UI

- The settings page reads **"AI provider: Local preview · Not connected"**.
- Every surface that calls the provider includes a "human approval required" disclaimer per `requiredDisclaimers` on the contract.
- No surface ever displays AI output as if it were a real metric.

## See also

- [prompt-contracts.md](./prompt-contracts.md)
- [cost-policy.md](./cost-policy.md)
- [safety-policy.md](./safety-policy.md)
- [../architecture/ai-and-auth-boundaries.md](../architecture/ai-and-auth-boundaries.md)
