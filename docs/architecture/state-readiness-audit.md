# State readiness audit

This document captures Signal's current state model just before the persistence layer is introduced. It is a deliberate stop: Supabase is not added in this phase. The audit's job is to make the eventual migration straight-shaped.

## Current state boundaries

Signal's runtime state lives in **one** place: the React reducer in [src/core/store/reducer.ts](../../src/core/store/reducer.ts), seeded at startup from `src/lib/mock/*`. The reducer holds:

```ts
interface SignalState {
  plan: WeeklyPlan;
  items: WeeklyPlanItem[];
  backlog: BacklogItem[];
  approvalEvents: ApprovalEvent[];
  accountsById: Record<string, GrowthAccount>;
  productsById: Record<string, ProductProfile>;
  lastMoves: { id: string; from: string; to: string; reason: string }[];
}
```

Everything else — risk scores, recommendations, opportunities, drafts, discoverability rows, freshness verdicts, search results, activity events — is **derived** from this state by pure functions. The derivation runs on every render.

## What lives outside the store

These are imported as static module-scoped data and never mutated:

- `src/lib/mock/products.ts` — product profiles.
- `src/lib/mock/platforms.ts` — platform policy.
- `src/lib/mock/workspace.ts` — single workspace.
- `src/lib/mock/risk.ts` — seeded risk events.
- `src/lib/mock/content-assets.ts` — content assets.
- `src/lib/mock/source-insights.ts` — source insight library.
- `src/lib/mock/discussions.ts` — discussion seeds.

Most of these are inputs that the founder would normally edit in a real settings flow. They are stable in shape; their content will move into a database in the next phase.

## Currently derived (must stay derived)

- **Risk score** per plan item — computed from the live `items` array and per-account/per-product state on every store mutation.
- **Cadence load** per platform.
- **Platform readiness snapshot** — derived from accounts.
- **Content opportunities** — derived from insights and product profiles.
- **Draft variants** — derived from opportunities.
- **Discussion opportunities** — derived from discussion seeds.
- **Comment / reply drafts** — derived from discussion opportunities.
- **Discoverability opportunities** — derived from content assets and insights.
- **Activity timeline** — derived from the entire state plus mock libraries.
- **Search index** — derived from the entire state plus mock libraries on every keystroke.

These should remain pure. Persisting them would create a sync problem (the derived shape would drift from the real source).

## Stable entities (good candidates for Supabase tables)

| Entity | Identity | Volatility | Notes |
|---|---|---|---|
| `Workspace` | id | very low | One per workspace; rarely changes. |
| `ProductProfile` | id | low | Tracking metadata, positioning, CTA policy. |
| `Platform` | id | very low | Effectively constant data. |
| `GrowthAccount` | id | medium | Status moves through the lifecycle; readiness updates. |
| `SourceInsight` | id | low | Created over time; rarely edited. |
| `ContentAsset` | id | medium | Freshness flips as time passes; can be edited. |
| `WeeklyPlan` | id (per week) | high | Status moves rapidly. |
| `WeeklyPlanItem` | id | high | Status, scheduledFor, drafts mutate often. |
| `BacklogItem` | id | medium | Created on save_to_backlog, removed on restore. |
| `ApprovalEvent` | id | append-only | Audit-friendly; append-only. |
| `RiskEvent` | id | medium | Today seeded; future events are derived. |
| `DiscussionOpportunity` (seed) | id | low | Seed shape stable; live data later. |

## Volatile fields (not table-shaped)

- `WeeklyPlanItem.risk` — recomputed on every mutation. Do not persist.
- `GrowthAccount.readinessScore` — recomputed from the checklist on every render. Do not persist.
- `WeeklyPlan.status` — derived from item statuses. Do not persist; compute on read.
- `SetupKit.contentIdeas / commentIdeas / warmUpDays` — deterministic generator outputs. Persisting them locks the founder out of a "refresh kit" workflow; keep them computed unless the founder customizes a specific value (which would justify a per-account override row).
- `ContentMemoryRecord` — derived per render. Persist only if cross-week reporting needs it.
- All `ContentOpportunity`, `DraftVariant`, `DiscoverabilityOpportunity`, `CommentDraft`, `ReplyDraft`, `ConversationRisk` rows.

## Recommended Supabase table boundaries (future)

```
workspaces            (id, name, owner, philosophy, created_at)
products              (id, workspace_id, slug, name, domain, ...)
platforms             (id, ...)                       # static reference
accounts              (id, workspace_id, product_id, platform, role, status, ...)
account_setup         (account_id, kit JSONB, checklist JSONB)
source_insights       (id, product_id, ...scores, content)
content_assets        (id, product_id, ...)
weekly_plans          (id, workspace_id, week_start, status)
weekly_plan_items     (id, plan_id, account_id, product_id, platform, content_type,
                       draft JSONB, scheduled_for, status)
backlog_items         (id, workspace_id, account_id, product_id, draft JSONB,
                       reason, moved_at)
approval_events       (id, plan_item_id, action, actor_email, occurred_at, note)
risk_events           (id, ...)                       # observed signals
activity_events       (id, ...)                       # if cross-week timeline is needed
```

Two notes on schema shape:

- `account_setup.kit` and `weekly_plan_items.draft` stay JSONB. Both are small, opaque payloads that the founder edits as a unit. Splitting them into columns would force tight schema migrations every time the kit gains a field.
- Risk scores, recommendations, and all derived rows do **not** get tables. They run on read.

## Migration risks

1. **Coupling the UI to JSONB columns.** Mitigated by keeping the existing TypeScript types as the contract — the database is an implementation detail behind the same interfaces.
2. **Mutating cross-cutting fields outside the reducer.** Easy to drift. Mitigated by funneling every write through the reducer (or a server action that fires the same actions).
3. **Stale derived state.** If derived rows are accidentally persisted, they age. Mitigated by the explicit list above: only persist what's marked as stable, never what's marked as derived.

## What does not need to change for the migration

- The store reducer's action shape.
- The page-level data dependencies (`useSignal`, `useAccounts`, `useApprovalActions`, etc.).
- The pure cores in `src/core/scheduler`, `src/core/risk`, `src/core/approval`, `src/core/onboarding`, `src/core/content-intelligence`, `src/core/comment-intelligence`, `src/core/discoverability`, `src/core/activity`, `src/core/search`.

The store will receive its initial state from Supabase instead of the mock module, and mutations will write through to Supabase as well. Otherwise the system is untouched.
