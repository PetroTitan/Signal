# Entity classification

Every entity in Signal classified by group, migration phase, and persistence rule. This is the input to [supabase-schema-plan.md](./supabase-schema-plan.md) and [migration-phases.md](./migration-phases.md).

## Reading the table

- **Group** — domain area.
- **Persist?** — `yes`, `no`, `partial` (only when founder-curated), or `derived` (always computed).
- **Phase** — when the table should land. Phases follow [migration-phases.md](./migration-phases.md).
- **Append-only** — whether rows are ever updated or deleted.
- **Notes** — the most important policy decision.

## 1. Identity & tenancy

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `users` | yes (via Supabase auth) | A | — | Managed by `auth.users`. Signal references `auth.uid()`. |
| `workspaces` | yes | A | no | One row per workspace; multi-workspace future. |
| `workspace_members` | yes | A | no | Maps `auth.uid()` to workspace + role. Required for RLS. |

## 2. Product system

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `products` | yes | A | no | `tracking_metadata` is JSONB. `target_audience`, `allowed_cta_copy`, `forbidden_claims` are JSONB arrays. |
| `product_claim_policies` | no (yet) | F+ | — | Stays as code constants unless customers author per-workspace policy. |

## 3. Account system

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `growth_accounts` | yes | A | no | Status transitions tracked separately. `readiness_score` is computed, not stored. |
| `account_setup_profiles` | yes | B | no | One row per account. `kit` is JSONB. |
| `account_checklist_items` | yes | B | no | Per-account per-checklist-item row. Enables atomic toggles and SQL-shaped progress. |
| `account_warmup_plans` | yes | B | no | One row per account. `days` is JSONB (the 14-day plan). |
| `account_status_history` | yes | B | yes | Append-only lifecycle audit. |
| `platform_connections` | yes (encrypted) | F | no | OAuth tokens stored encrypted. See [oauth-token-storage-plan.md](./oauth-token-storage-plan.md). |

## 4. Weekly operations

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `weekly_plans` | yes | A | no | One row per week per workspace. |
| `weekly_plan_items` | yes | A | no | `draft` is JSONB. `risk_snapshot` is JSONB. |
| `approval_events` | yes | A | yes | Decision log. |
| `backlog_items` | yes | A | no | `draft`, `risk_snapshot` are JSONB. |
| `activity_events` | yes | A | yes | Operational timeline. Replaces today's per-render derivation. |
| `scheduled_posts` | no (yet) | F | — | Only meaningful once publishing arrives. |

## 5. Risk and cadence

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `risk_events` | yes | A | yes | Observed signals. |
| `risk_snapshots` | yes | A | no | Item-level rescores attached to plan items. Acts as a cache. |
| `cadence_events` | derived | — | — | Cadence load is recomputed from items; no table needed. |
| `risk_rules` | no | F+ | — | Stays as code constants. Migrate only if per-workspace customization arrives. |

## 6. Content intelligence

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `source_insights` | yes | C | no | `audience`, `platform_fit` are JSONB. Scores are integer columns. |
| `content_opportunities` | partial | C | no | Persist only founder-curated rows (queued, edited, skipped). Pure derivation stays computed. |
| `draft_variants` | partial | C | no | Persist only selected/edited variants. Discarded variants do not persist. |
| `content_memory_records` | partial | C | no | Persist only if cross-week reporting needs it; otherwise reconstruct from `weekly_plan_items`. |
| `guardrail_flags` | derived | — | — | Enum union, not a table. |

## 7. Comment intelligence

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `discussion_opportunities` | yes (when observed) | C | no | Persist real-world threads when platform APIs ship. Mock seeds stay as fixtures. |
| `comment_drafts` | partial | C | no | Persist only founder-saved drafts. |
| `reply_drafts` | partial | C | no | Same rule as comment drafts. |
| `conversation_risks` | derived | — | — | Snapshot lives next to its draft as JSONB. |
| `participation_recommendations` | derived | — | — | Computed from the discussion opportunity. |

## 8. Discoverability

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `content_assets` | yes | D | no | `internal_links`, `amplification`, `notes` are JSONB. `freshness` is computed; do not store. |
| `discoverability_opportunities` | partial | D | no | Persist only when founder pins, resolves, or defers. |
| `topical_clusters` | derived | — | — | Optional materialized view. |
| `freshness_snapshots` | derived | — | — | Computed from `content_assets.updated_at`. |
| `youtube_ideas` | partial | D | no | Persist edited ideas; default seeds stay computed. |
| `youtube_cadence_plan` | derived | — | — | Per product, computed. |

## 9. Analytics / WebmasterID

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `tracking_links` | yes | E | no | UTM shape already standardized in `ProductProfile.trackingMetadata`. |
| `campaign_attribution` | yes | E | no | Filled by the WebmasterID stream. |
| `performance_events` | yes | E | yes | Append-only fact table for analytics. |
| `webmasterid_connections` | yes | E | no | One row per workspace; encrypted connection details. |

## 10. System

| Entity | Persist | Phase | Append-only | Notes |
|---|---|---|---|---|
| `audit_logs` | yes | A | yes | Cross-cutting audit (auth events, settings changes, integration toggles). |
| `integration_statuses` | yes | A | no | Per-workspace per-provider current status. |
| `settings` | yes | A | no | Workspace-scoped key/value JSONB or columns on `workspaces`. |

## SaaS (later)

| Entity | Persist | Phase | Notes |
|---|---|---|---|
| `subscriptions` | yes | F+ | Stripe shape. |
| `usage_limits` | yes | F+ | Per-plan quotas. |
| `billing_customers` | yes | F+ | Stripe customer ↔ workspace map. |
| `team_invitations` | yes | F+ | Pending invitations. |
| `organization_settings` | yes | F+ | Future multi-org collapse if needed. |

## Phase summary

| Phase | Tables | Why now |
|---|---|---|
| **A** Core | `workspaces`, `workspace_members`, `products`, `growth_accounts`, `weekly_plans`, `weekly_plan_items`, `approval_events`, `backlog_items`, `activity_events`, `risk_events`, `risk_snapshots`, `audit_logs`, `integration_statuses` | The minimum viable persistence for the founder to keep working across sessions. |
| **B** Onboarding | `account_setup_profiles`, `account_checklist_items`, `account_warmup_plans`, `account_status_history` | Required to make account setup durable. |
| **C** Intelligence | `source_insights`, `content_opportunities` (partial), `draft_variants` (partial), `content_memory_records` (partial), `discussion_opportunities`, `comment_drafts` (partial), `reply_drafts` (partial) | Required so insights, opportunities, and drafts survive restarts. |
| **D** Discoverability | `content_assets`, `discoverability_opportunities` (partial), `youtube_ideas` (partial) | Required when the founder authors and edits content assets. |
| **E** Analytics | `tracking_links`, `campaign_attribution`, `performance_events`, `webmasterid_connections` | Required when WebmasterID is wired. |
| **F** OAuth | `platform_connections` (encrypted), per-provider scope tables if needed | Required when real OAuth integrations ship. |
| **F+** SaaS | `subscriptions`, `usage_limits`, `billing_customers`, `team_invitations` | Required when Signal becomes multi-tenant SaaS. |

This classification is the basis for [migration-phases.md](./migration-phases.md).
