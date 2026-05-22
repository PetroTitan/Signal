# One-time setup principle

Signal is built to feel like durable infrastructure. The user configures their product, their workspace, and their accounts once, and the system continues to work for months or years without reconfiguration. This document explains the architectural choices that make that real.

## The five things the user configures

1. **Product profile** — name, audience, positioning, allowed/blocked topics, claim restrictions.
2. **Workspace memory** — tone, communication style, promotion level, risk tolerance, link policy, cadence policy.
3. **Platform connections** — one official OAuth flow per platform account.
4. **Weekly review behavior** — which day, which level of detail.
5. **Operational preferences** — variant count, blocked phrases, preferred phrases.

After this, Signal does the rest. The user reviews one weekly plan. They reauthorize only when a platform forces them to.

## What "configure once" means in the schema

Every entity that drives behavior carries:

- `schemaVersion: number` — additive evolution; bumps only when meaning changes.
- `lastUpdatedAt: string` — when the row last changed.
- `source: "user" | "derived" | "default"` — whether the row came from the user, a derivation, or a built-in default.
- `active: boolean` — soft retirement instead of deletion.

This shape is shared across `WorkspaceMemory`, `ProductMemory`, `AccountMemory`, and `AiPreference`. Memory profiles are versioned, human-editable, and migration-safe. They are not derived from prompts the user wrote in a chat box.

## Stable memory requirements

Once configured, Signal reuses:

- Workspace tone.
- Product positioning.
- Platform rules.
- Account cadence preferences.
- Blocked claims.
- Allowed topics.
- Risk tolerance.

The user does not explain the same product twice. The retriever pulls the relevant entity, the assembler injects it into the prompt, the AI provider receives it. No re-typing.

## Backward-compatible evolution

Rules every persisted entity follows:

- Never rely on giant unstructured blobs.
- Prefer typed fields.
- Support `schemaVersion`.
- Support `migration_notes` in the database layer.
- Support deprecated fields safely.
- Keep stored fields separate from computed fields.
- Preserve old approved drafts and approval events.

Approved drafts in particular are durable: a schema change to memory must not invalidate or destroy past approvals.

## Long-lived connections

Connections live behind the typed `ConnectionProvider` interface. Each connection carries a `ConnectionHealthRecord` with its own `schema_version`, refresh expiry, failure counter, and recovery action. Three failed syncs in a row drop the connection to `draft_only` mode — never destructive failure, never silent data loss.

See [../platforms/long-lived-connections.md](../platforms/long-lived-connections.md) for the full lifecycle and self-healing rules.

## Reliability-first UX language

The product copy reflects what is actually true:

- "Configure once. Signal reuses your product, platform, and account context."
- "Connections may occasionally require reauthorization if a platform changes permissions."
- "Signal falls back to draft-only mode instead of breaking the workflow."

It avoids:

- "Works forever."
- "Never reconnect."
- "Guaranteed publishing."
- "No bugs."

The architecture earns trust by being honest about failure modes — not by claiming they cannot happen.

## What the user never has to do

- Re-enter product context.
- Reconfigure tone.
- Reconnect accounts unnecessarily.
- Rebuild weekly workflows.
- Recreate memory profiles.
- Manually fix stale settings.

If any of these become necessary, that is a bug worth fixing — not a feature to document.

## What never gets stored, even for long-lived ops

- Passwords.
- Cookies.
- Browser sessions.
- 2FA codes.
- Recovery codes.
- Proxy fingerprints, anti-detect profiles.

Only official OAuth tokens, encrypted and server-side, when integrations ship.

## Final reliability goal

Signal should behave like durable infrastructure:

- Configure once.
- Reuse context safely.
- Monitor connection health.
- Recover gracefully.
- Preserve user work.
- Require human approval.
- Never silently publish when account health is uncertain.

## See also

- [../platforms/long-lived-connections.md](../platforms/long-lived-connections.md)
- [../platforms/account-authentication-readiness.md](../platforms/account-authentication-readiness.md)
- [../platforms/oauth-first-principle.md](../platforms/oauth-first-principle.md)
- [../ai/memory-architecture.md](../ai/memory-architecture.md)
- [../database/memory-schema-plan.md](../database/memory-schema-plan.md)
