# Risk and draft persistence

Phase D adds two append-friendly tables that future phases will lean on heavily:

## `risk_events`

Append-only signals about a workspace entity (plan item, account, product, etc.).

| Column | Notes |
| --- | --- |
| `entity_type` | Polymorphic discriminator: `weekly_plan_item`, `growth_account`, `product`, etc. |
| `entity_id` | UUID of the target row (nullable). |
| `risk_level` | low / medium / high / blocked. Same scale used by the in-memory risk engine. |
| `risk_score` | Optional 0–100 score. |
| `reason` | Required short string. |
| `recommendation` | Optional remediation note. |
| `metadata` | JSONB for forward-friendly extension. |

Repository: `src/repositories/risk-event-repository.ts` — `listRiskEvents`, `recordRiskEvent`.

Today the application does not yet emit risk events automatically — the table exists so the deterministic risk engine can persist its scoring decisions in a later phase without a schema migration. `/risk-center` continues to render from the React store.

## `draft_variants`

Stored drafts for a plan item or product.

| Column | Notes |
| --- | --- |
| `product_id` | Optional. Variants can be product-level (reusable) or item-level (one-off). |
| `weekly_plan_item_id` | Optional. Cascades on item delete. |
| `platform` | Optional platform discriminator. |
| `variant_type` | Free-form (e.g. `rewrite_softer`, `convert_to_comment`, `comment_reply`). |
| `title` | Optional. |
| `body` | Required. |
| `status` | draft / selected / discarded. |
| `risk_level` | Optional, mirrors the plan-item risk levels. |
| `metadata` | JSONB. |

Repository: `src/repositories/draft-variant-repository.ts` — `listDraftVariants` (filter by item or product), `createDraftVariant`, `updateDraftVariant`.

When the AI provider becomes real in a future phase, the existing `MockAiProvider.generate(...)` path will route results into `draft_variants` via `createDraftVariant`. The contracts already exist (`src/core/ai/prompt-contracts.ts`); the persistence side is now wired.

## RLS

Both tables are workspace-scoped. `risk_events` is append-only (no UPDATE / DELETE policy). `draft_variants` is mutable so the user can mark a variant as `selected` or `discarded`.

## Why ship the tables now if no UI uses them yet

Phase D's narrow goal was to land the table contract so future phases can connect AI runtime and engine output without another migration round. The tables are documented, RLS-protected, and the repositories are typed and ready.

## See also

- [./phase-d-migrations.md](./phase-d-migrations.md)
- [./approval-backlog-scheduler-persistence.md](./approval-backlog-scheduler-persistence.md)
- [../ai/memory-architecture.md](../ai/memory-architecture.md)
