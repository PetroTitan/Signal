# Trust and safety

Signal's trust positioning is a product decision, surfaced in the UI as well as in policy. Phase 8 consolidated that voice into one canonical source and one shared component.

## One source of truth

`src/lib/trust-copy.ts` exports the canonical strings:

- The headline: *"Signal never asks for your platform password."*
- The body paragraph: what Signal will never request (passwords, cookies, session tokens, 2FA codes, recovery codes) and why OAuth-first is the only path.
- The approval line: *"Human approval remains central to the workflow. Signal flags, recommends, and schedules — you decide."*
- The full list of behaviors Signal does not do (no auto-publish, no auto-comment, no auto-index, no anti-detect tooling, no proxies, no account farms).
- Per-platform OAuth strings for the "not yet enabled" cards.

All trust UI reads from this file. Changing the canonical voice changes every surface at once.

## The shared TrustPanel

`src/components/trust-panel.tsx` is the one component every page uses for trust messaging:

```tsx
<TrustPanel />                       // full
<TrustPanel compact />               // headline + body only
<TrustPanel includeApproval />       // full + the approval line
```

Used on:

- The accounts list page (full).
- Onboarding wizard and account detail (full, with approval).
- Settings page (full).
- Platform command centers (compact, paired with the platform-specific OAuth card).

## OAuth-first as a structural principle

Signal&apos;s account model has one connection path: official OAuth. Until OAuth providers are wired in, every command center carries a disabled connect button with a clear "not yet enabled" hint. The button never disappears — its presence is part of the promise.

Reasons the design holds:

- Anti-detect tooling and credential-storing automation are the fastest way to get a founder&apos;s account permanently locked.
- Growth produced by bypassing platform systems does not compound; it lives one policy change away from being deleted.
- Storing platform passwords creates a security surface Signal does not want and a perception cost Signal can&apos;t afford.

## Human approval is structural

Every item Signal surfaces is a recommendation. There is no path through the system that bypasses the weekly review:

- Drafts are scanned by the guardrail layer before reaching the approval queue.
- The conversation risk layer scores every comment and reply.
- The risk engine flags before it blocks; recommendations stay calm.
- Schedule moves carry explicit reasons.
- The discoverability layer surfaces opportunities, not actions.

## Marketing surfaces

The `(marketing)` route group exposes the same positioning publicly:

- [/about](../../src/app/(marketing)/about/page.tsx) — what Signal is and isn&apos;t.
- [/philosophy](../../src/app/(marketing)/philosophy/page.tsx) — the seven philosophical commitments.
- [/security](../../src/app/(marketing)/security/page.tsx) — the security posture as principles, not a checklist.
- [/how-it-works](../../src/app/(marketing)/how-it-works/page.tsx) — the operating loop.

The marketing pages don&apos;t invent metrics, fabricate users, or list integrations that don&apos;t exist. Everything they say is true today.

## What this layer never does

- It never softens a guardrail to push more items through approval.
- It never invents a "secure mode" that disables a principle to ship faster.
- It never ships an integration that asks for credentials outside OAuth.
- It never hides the "not yet enabled" message — the absence of an integration is honest, and it stays visible.
