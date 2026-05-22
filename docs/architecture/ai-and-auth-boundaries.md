# AI and authentication boundaries

Signal carries two integration boundaries that share an architecture: AI providers and platform authentication. This document captures the rules both live under so the future integrations don't drift.

## Shared rules

1. **The browser never holds a secret.** No `OPENAI_API_KEY` in the client. No OAuth client secrets. No platform tokens. Server-side only.
2. **All real integrations go through a typed interface.** `AiProvider` and `ConnectionProvider`. The UI never imports `openai` or platform SDKs directly.
3. **Mocks are first-class.** Each interface has a deterministic mock (`MockAiProvider`, `MockConnectionProvider`). Tests and the empty-state UI use them.
4. **Errors don't leak.** Internal codes like `invalid_grant` or `token hydration failed` are translated to plain user messages at the interface boundary.
5. **Human approval is structural.** AI generation and platform publishing both flow through the weekly approval queue. There is no "agent mode," no autonomous loop.

## AI side (today)

```
UI surface
  └── getActiveAiProvider() → AiProvider
        ├── MockAiProvider  (deterministic, in-browser)
        └── OpenAiProviderPlaceholder  (returns provider_not_connected)
```

Future:

```
UI surface
  └── getActiveAiProvider() → AiProvider
        └── OpenAiProvider (server-side; receives requests via Next.js Route Handler)
```

Contracts and outputs stay the same. The UI doesn't change.

## Platform connection side (today)

```
Settings surface
  └── new MockConnectionProvider()
        └── .list()  → [PlatformConnection { status: 'not_connected', ... }, ...]
        └── .startConnect()  → not_implemented error
        └── .revoke()        → not_implemented error
```

Future:

```
Settings surface
  └── ConnectionProvider (server-backed)
        ├── .list()           → real connections from DB
        ├── .startConnect()   → returns OAuth authorization URL
        ├── .completeConnect()→ handles OAuth callback
        └── .revoke()         → revokes tokens, writes audit row
```

The contract stays. Mock and real implementations are swappable.

## What lives on the server when integrations ship

- The OpenAI client and its API key.
- Platform OAuth client IDs, client secrets, and stored tokens (encrypted at rest).
- The Route Handlers that wrap `AiProvider.generate()` and the OAuth callback.
- All telemetry sinks.

## What stays on the client

- The `AiProvider` interface and the typed contracts.
- The `ConnectionProvider` interface and the typed connection model.
- The mock implementations.
- Render logic; nothing else.

## What this boundary never permits

- A provider that "calls the OpenAI client directly from the browser if available."
- A connection flow that asks the user to paste a token.
- An OAuth path that exposes tokens to JavaScript on any page.
- A telemetry sink that ships raw inputs to a third party.
- A "fallback mode" that disables the type contract.

## See also

- [../ai/ai-integration-readiness.md](../ai/ai-integration-readiness.md)
- [../platforms/account-authentication-readiness.md](../platforms/account-authentication-readiness.md)
- [../database/oauth-token-storage-plan.md](../database/oauth-token-storage-plan.md)
