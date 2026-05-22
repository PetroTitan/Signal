# Supabase schema plan

This is the table-by-table plan for Signal's future Supabase persistence. **No migrations are written**; **no Supabase client is installed**. This is the source of truth for what the schema will look like when it lands.

Conventions:

- All primary keys are `uuid` with `default gen_random_uuid()` unless otherwise noted.
- Timestamps are `timestamptz`, defaulting to `now()` where appropriate.
- Soft-delete via `deleted_at timestamptz null` where listed.
- Every workspace-scoped table carries `workspace_id uuid not null references workspaces(id) on delete cascade`.
- `actor_user_id uuid null references auth.users(id) on delete set null` is used for foreign keys to Supabase auth.
- JSONB is used when the payload is a small document edited as a unit, not when it's a list of independently queryable rows.

---

## Phase A — Core tables

### `workspaces`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `name` | text | no | — | "HELPERG Growth Workspace" |
| `owner_user_id` | uuid | yes | — | references `auth.users` |
| `owner_email` | text | yes | — | fallback before Supabase auth |
| `philosophy` | text | yes | — | calm-cadence statement |
| `created_at` | timestamptz | no | `now()` | |
| `updated_at` | timestamptz | no | `now()` | maintained by trigger |
| `deleted_at` | timestamptz | yes | — | soft-delete |

Indexes: PK only. Single-row use today.

RLS: only members of the workspace can `select`. Only owners can `update`. See [rls-security-plan.md](./rls-security-plan.md).

### `workspace_members`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `workspace_id` | uuid | no | — | FK workspaces |
| `user_id` | uuid | no | — | FK `auth.users` |
| `role` | workspace_role | no | `'editor'` | enum: owner / admin / editor / reviewer / viewer |
| `invited_email` | text | yes | — | for pending invitations |
| `joined_at` | timestamptz | yes | — | null until accepted |
| `created_at` | timestamptz | no | `now()` | |

Indexes: `(workspace_id, user_id)` unique; `(user_id)` for "my workspaces" lookups.

### `products`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `slug` | text | no | — | unique within workspace |
| `name` | text | no | — | |
| `domain` | text | yes | — | |
| `category` | product_category | no | — | enum |
| `positioning` | text | yes | — | |
| `content_style` | text | yes | — | |
| `cta_style` | cta_style | no | `'soft_mention'` | enum |
| `risk_tolerance` | risk_tolerance | no | `'balanced'` | enum |
| `target_audience` | jsonb | no | `'[]'` | array of strings |
| `allowed_cta_copy` | jsonb | no | `'[]'` | array of strings |
| `forbidden_claims` | jsonb | no | `'[]'` | array of strings |
| `preferred_platforms` | jsonb | no | `'[]'` | array of platform ids |
| `tracking_metadata` | jsonb | no | `'{}'` | utm map + campaign prefix |
| `created_at` | timestamptz | no | `now()` | |
| `updated_at` | timestamptz | no | `now()` | |
| `deleted_at` | timestamptz | yes | — | |

Indexes: `(workspace_id, slug)` unique; `(workspace_id)` for list view.

### `growth_accounts`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `product_id` | uuid | no | — | FK products |
| `platform` | social_platform | no | — | enum: reddit / x / linkedin |
| `role` | account_role | no | — | enum |
| `handle` | text | yes | — | can be null pre-creation |
| `display_name` | text | no | — | |
| `status` | account_status | no | `'planned'` | enum |
| `oauth_connected` | boolean | no | `false` | |
| `last_activity_at` | timestamptz | yes | — | |
| `created_at` | timestamptz | no | `now()` | |
| `updated_at` | timestamptz | no | `now()` | |

Indexes: `(workspace_id, product_id)`, `(workspace_id, platform, status)`.

Note: `readiness_score` is **not stored**. Computed from `account_checklist_items`.

### `weekly_plans`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `week_start` | date | no | — | Monday |
| `week_end` | date | no | — | Sunday |
| `status` | weekly_plan_status | no | `'drafting'` | enum |
| `created_at` | timestamptz | no | `now()` | |
| `finalized_at` | timestamptz | yes | — | when status leaves `drafting` |

Indexes: `(workspace_id, week_start)` unique.

### `weekly_plan_items`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `plan_id` | uuid | no | — | FK weekly_plans |
| `workspace_id` | uuid | no | — | denormalized for RLS perf |
| `account_id` | uuid | no | — | |
| `product_id` | uuid | no | — | |
| `platform` | social_platform | no | — | |
| `content_type` | content_type | no | — | enum |
| `draft` | jsonb | no | `'{}'` | hook, body, cta, tracking_link_id |
| `scheduled_for` | timestamptz | no | — | |
| `status` | plan_item_status | no | `'pending_approval'` | enum |
| `risk_snapshot` | jsonb | no | `'{}'` | latest scored risk |
| `created_at` | timestamptz | no | `now()` | |
| `updated_at` | timestamptz | no | `now()` | |

Indexes: `(plan_id, status)`, `(account_id, scheduled_for)`, `(workspace_id, scheduled_for)`.

### `approval_events`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `plan_item_id` | uuid | no | — | FK weekly_plan_items |
| `workspace_id` | uuid | no | — | denormalized for RLS |
| `action` | approval_action | no | — | enum |
| `actor_user_id` | uuid | yes | — | FK auth.users |
| `actor_email` | text | yes | — | fallback |
| `occurred_at` | timestamptz | no | `now()` | |
| `note` | text | yes | — | |

Indexes: `(plan_item_id, occurred_at desc)`, `(workspace_id, occurred_at desc)`.

Append-only: `update` and `delete` policies denied.

### `backlog_items`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `source_plan_item_id` | uuid | yes | — | FK weekly_plan_items |
| `account_id` | uuid | no | — | |
| `product_id` | uuid | no | — | |
| `platform` | social_platform | no | — | |
| `content_type` | content_type | no | — | |
| `draft` | jsonb | no | `'{}'` | |
| `risk_snapshot` | jsonb | no | `'{}'` | |
| `reason` | text | no | — | |
| `moved_at` | timestamptz | no | `now()` | |
| `restored_at` | timestamptz | yes | — | when pulled back into a plan |

Indexes: `(workspace_id, platform)`, `(workspace_id, moved_at desc)`.

### `activity_events`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `occurred_at` | timestamptz | no | `now()` | |
| `type` | activity_event_type | no | — | enum |
| `entity_type` | activity_entity_type | no | — | enum |
| `entity_id` | uuid | yes | — | references the relevant table by convention |
| `layer` | activity_layer | no | — | enum: core / platform_social / platform_search / intelligence / operations / configuration |
| `platform` | text | yes | — | nullable; can be `'google'` for the discoverability layer |
| `product_id` | uuid | yes | — | |
| `severity` | activity_severity | no | `'info'` | enum |
| `title` | text | no | — | |
| `explanation` | text | yes | — | |
| `link` | text | yes | — | route inside the app |
| `payload` | jsonb | no | `'{}'` | extra context |

Indexes: `(workspace_id, occurred_at desc)`, `(workspace_id, layer, occurred_at desc)`.

Append-only.

### `risk_events`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `category` | risk_category | no | — | enum |
| `level` | risk_level | no | — | enum: low / medium / high / blocked |
| `account_id` | uuid | yes | — | |
| `product_id` | uuid | yes | — | |
| `platform` | social_platform | yes | — | |
| `plan_item_id` | uuid | yes | — | |
| `detected_at` | timestamptz | no | `now()` | |
| `resolved_at` | timestamptz | yes | — | |
| `summary` | text | no | — | |
| `recommendation` | text | yes | — | |

Indexes: `(workspace_id, detected_at desc)`, `(workspace_id, level)`, `(plan_item_id)`.

Append-only on insert; `resolved_at` is the one mutable column.

### `risk_snapshots`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `plan_item_id` | uuid | no | — | |
| `score` | smallint | no | — | 0–100 |
| `level` | risk_level | no | — | |
| `reasons` | jsonb | no | `'[]'` | |
| `recommendation` | text | yes | — | |
| `computed_at` | timestamptz | no | `now()` | |

Indexes: `(plan_item_id, computed_at desc)`. Latest snapshot per item is used by reads.

### `audit_logs`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | yes | — | nullable for cross-workspace events |
| `actor_user_id` | uuid | yes | — | |
| `action` | text | no | — | snake-cased verb |
| `entity_type` | text | yes | — | |
| `entity_id` | uuid | yes | — | |
| `occurred_at` | timestamptz | no | `now()` | |
| `metadata` | jsonb | no | `'{}'` | |

Indexes: `(workspace_id, occurred_at desc)`. Append-only.

### `integration_statuses`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `provider` | text | no | — | e.g. `'webmasterid'`, `'reddit'`, `'x'`, `'linkedin'`, `'google'` |
| `status` | connection_status | no | `'not_connected'` | enum |
| `last_checked_at` | timestamptz | yes | — | |
| `last_error` | text | yes | — | |

Unique: `(workspace_id, provider)`. Indexes: `(workspace_id)`.

---

## Phase B — Account onboarding tables

### `account_setup_profiles`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `account_id` | uuid | no | — | PK and FK |
| `workspace_id` | uuid | no | — | denormalized |
| `kit` | jsonb | no | `'{}'` | usernames, bios, about text, content/comment ideas, avatar/cover briefs, platform-specific extras, tone reminders, cadence note |
| `generated_at` | timestamptz | no | `now()` | |
| `updated_at` | timestamptz | no | `now()` | |

### `account_checklist_items`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `account_id` | uuid | no | — | |
| `item_id` | text | no | — | stable string id: `kit_generated`, `manual_account_created`, etc. |
| `label` | text | no | — | rendered label |
| `category` | checklist_category | no | — | enum: kit / manual / security / profile / oauth / planning |
| `done` | boolean | no | `false` | |
| `done_at` | timestamptz | yes | — | |
| `created_at` | timestamptz | no | `now()` | |

Unique: `(account_id, item_id)`. Indexes: `(account_id)`.

### `account_warmup_plans`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `account_id` | uuid | no | — | PK |
| `days` | jsonb | no | `'[]'` | 14 entries: day, focus, description |
| `generated_at` | timestamptz | no | `now()` | |

### `account_status_history`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `account_id` | uuid | no | — | |
| `from_status` | account_status | yes | — | null for first transition |
| `to_status` | account_status | no | — | |
| `actor_user_id` | uuid | yes | — | |
| `occurred_at` | timestamptz | no | `now()` | |
| `note` | text | yes | — | |

Indexes: `(account_id, occurred_at desc)`. Append-only.

---

## Phase C — Content & comment intelligence tables

### `source_insights`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `product_id` | uuid | no | — | |
| `title` | text | no | — | |
| `core_insight` | text | no | — | |
| `summary` | text | yes | — | |
| `category` | insight_category | no | — | enum |
| `source_type` | insight_category | no | — | enum (today same union) |
| `audience` | jsonb | no | `'[]'` | array of `insight_audience` |
| `platform_fit` | jsonb | no | `'{}'` | per-platform fit map |
| `discoverability_potential` | smallint | no | `0` | 0–100 |
| `evergreen_score` | smallint | no | `0` | 0–100 |
| `conversation_score` | smallint | no | `0` | 0–100 |
| `freshness_potential` | smallint | no | `0` | 0–100 |
| `risk_level` | risk_level | no | `'low'` | |
| `created_at` | timestamptz | no | `now()` | |
| `archived_at` | timestamptz | yes | — | |

Indexes: `(workspace_id, product_id)`, `(workspace_id, archived_at)`.

### `content_opportunities`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `insight_id` | uuid | no | — | |
| `product_id` | uuid | no | — | |
| `channel` | text | no | — | platform id or `'google'` |
| `kind` | content_opportunity_kind | no | — | enum |
| `title` | text | no | — | |
| `rationale` | text | yes | — | |
| `impact` | opportunity_impact | no | `'medium'` | enum |
| `status` | opportunity_status | no | `'candidate'` | enum |
| `created_at` | timestamptz | no | `now()` | |

Persist only when status leaves `candidate`. Indexes: `(workspace_id, status)`, `(insight_id)`.

### `draft_variants`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `opportunity_id` | uuid | no | — | |
| `insight_id` | uuid | no | — | |
| `platform` | social_platform | no | — | |
| `kind` | content_opportunity_kind | no | — | |
| `tone_strength` | tone_strength | no | — | enum |
| `cta_intensity` | cta_intensity | no | — | enum |
| `hook` | text | no | — | |
| `body` | text | no | — | |
| `cta` | text | yes | — | |
| `has_link` | boolean | no | `false` | |
| `guardrail_flags` | jsonb | no | `'[]'` | |
| `version` | smallint | no | `1` | bumps on edit |
| `created_at` | timestamptz | no | `now()` | |

Persist only saved/edited variants. Indexes: `(opportunity_id, version desc)`.

### `content_memory_records`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `insight_id` | uuid | no | — | |
| `week_start` | date | no | — | |
| `channels` | jsonb | no | `'[]'` | |
| `created_at` | timestamptz | no | `now()` | |

Unique: `(insight_id, week_start)`.

### `discussion_opportunities`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `platform` | social_platform | no | — | |
| `context` | discussion_context | no | — | enum: subreddit_thread / x_thread / linkedin_post |
| `context_label` | text | no | — | |
| `thread_title` | text | no | — | |
| `thread_summary` | text | yes | — | |
| `question` | text | yes | — | |
| `url` | text | yes | — | |
| `topic_tags` | jsonb | no | `'[]'` | |
| `product_matches` | jsonb | no | `'[]'` | |
| `participation` | jsonb | no | `'{}'` | freshness/audience/noise |
| `community_fit` | jsonb | no | `'{}'` | level + reason |
| `matched_insight_ids` | jsonb | no | `'[]'` | |
| `participation_score` | smallint | no | `0` | |
| `recommendation` | participation_recommendation | no | — | enum: participate / watch / skip |
| `skip_reason` | text | yes | — | |
| `age_hours` | integer | yes | — | |
| `observed_at` | timestamptz | no | `now()` | |

Indexes: `(workspace_id, observed_at desc)`, `(workspace_id, platform, recommendation)`.

### `comment_drafts` and `reply_drafts`

Same shape (one row per draft):

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `opportunity_id` | uuid | no | — | |
| `platform` | social_platform | no | — | |
| `body` | text | no | — | |
| `tone_strength` | tone_strength | no | — | |
| `has_link` | boolean | no | `false` | |
| `guardrail_flags` | jsonb | no | `'[]'` | |
| `risk` | jsonb | no | `'{}'` | |
| `version` | smallint | no | `1` | |
| `created_at` | timestamptz | no | `now()` | |

Persist only founder-saved drafts.

---

## Phase D — Discoverability tables

### `content_assets`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `product_id` | uuid | no | — | |
| `cluster` | text | no | — | |
| `kind` | content_asset_kind | no | — | enum |
| `url` | text | no | — | |
| `title` | text | no | — | |
| `summary` | text | yes | — | |
| `published_at` | timestamptz | yes | — | |
| `updated_at` | timestamptz | no | `now()` | |
| `indexed` | boolean | no | `true` | mock today |
| `mock_search_position` | smallint | yes | — | replaced by real data later |
| `internal_links` | jsonb | no | `'{"incoming":0,"outgoing":0}'` | |
| `amplification` | jsonb | no | `'{"reddit":0,"x":0,"linkedin":0}'` | |
| `notes` | jsonb | no | `'[]'` | |
| `archived_at` | timestamptz | yes | — | |

Indexes: `(workspace_id, product_id)`, `(workspace_id, cluster)`.

Note: `freshness` is **not stored**. Computed from `updated_at` + amplification.

### `discoverability_opportunities`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `asset_id` | uuid | yes | — | |
| `product_id` | uuid | no | — | |
| `cluster` | text | yes | — | |
| `kind` | discoverability_opportunity_kind | no | — | enum |
| `title` | text | no | — | |
| `detail` | text | yes | — | |
| `suggested_action` | text | yes | — | |
| `impact` | discoverability_impact | no | `'medium'` | enum |
| `status` | opportunity_status | no | `'candidate'` | enum |
| `created_at` | timestamptz | no | `now()` | |
| `resolved_at` | timestamptz | yes | — | |

Persist only when status leaves `candidate`.

### `youtube_ideas`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `product_id` | uuid | no | — | |
| `kind` | youtube_format_kind | no | — | enum |
| `title` | text | no | — | |
| `description` | text | yes | — | |
| `status` | opportunity_status | no | `'candidate'` | |
| `created_at` | timestamptz | no | `now()` | |

Persist only edited ideas.

---

## Phase E — Analytics tables

### `tracking_links`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `product_id` | uuid | no | — | |
| `account_id` | uuid | yes | — | |
| `platform` | text | no | — | |
| `signal_campaign_id` | text | no | — | |
| `signal_item_id` | text | yes | — | |
| `utm_source` | text | no | `'signal'` | |
| `utm_medium` | text | no | — | |
| `utm_campaign` | text | no | — | |
| `destination_url` | text | no | — | |
| `created_at` | timestamptz | no | `now()` | |

Indexes: `(workspace_id, product_id)`, `(signal_item_id)`.

### `campaign_attribution`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `tracking_link_id` | uuid | no | — | |
| `workspace_id` | uuid | no | — | |
| `visits` | integer | no | `0` | |
| `sessions` | integer | no | `0` | |
| `signups` | integer | no | `0` | |
| `conversions` | integer | no | `0` | |
| `last_updated_at` | timestamptz | no | `now()` | |

### `performance_events`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `tracking_link_id` | uuid | no | — | |
| `workspace_id` | uuid | no | — | |
| `event_type` | text | no | — | `'visit'`, `'signup'`, `'conversion'`, etc. |
| `occurred_at` | timestamptz | no | — | |
| `metadata` | jsonb | no | `'{}'` | |

Indexes: `(workspace_id, occurred_at desc)`. Append-only.

### `webmasterid_connections`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | unique |
| `status` | connection_status | no | `'not_connected'` | |
| `connected_at` | timestamptz | yes | — | |
| `last_synced_at` | timestamptz | yes | — | |
| `encrypted_api_key` | bytea | yes | — | encrypted at rest; see [oauth-token-storage-plan.md](./oauth-token-storage-plan.md) |

Unique: `(workspace_id)`.

---

## Phase F — OAuth + publishing

### `platform_connections`

Detailed in [oauth-token-storage-plan.md](./oauth-token-storage-plan.md).

### `scheduled_posts`

| Column | Type | Nullable | Default | Notes |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | |
| `workspace_id` | uuid | no | — | |
| `plan_item_id` | uuid | no | — | |
| `platform_connection_id` | uuid | no | — | |
| `scheduled_for` | timestamptz | no | — | |
| `status` | scheduled_post_status | no | `'queued'` | enum |
| `attempt_count` | smallint | no | `0` | |
| `last_attempt_at` | timestamptz | yes | — | |
| `last_error` | text | yes | — | |
| `external_post_id` | text | yes | — | platform's id once published |
| `published_at` | timestamptz | yes | — | |

Indexes: `(workspace_id, scheduled_for)`, `(plan_item_id)`.

---

## Phase F+ — SaaS readiness

Outlined briefly; full design when billing is on the table.

- `subscriptions` — Stripe subscription metadata.
- `usage_limits` — per-plan quotas (insight count, weekly item count, etc.).
- `billing_customers` — Stripe customer ↔ workspace.
- `team_invitations` — pending invitations to `workspace_members`.
- `organization_settings` — only if multi-org collapse is needed.

---

## Trigger conventions

- `updated_at` columns auto-update via a single shared `set_updated_at()` trigger.
- `account_status_history` rows are inserted by a trigger on `growth_accounts.status` changes.
- `risk_snapshots` are written by the application layer, not by triggers.

## Enum conventions

All enums listed here are catalogued in [enums-and-statuses.md](./enums-and-statuses.md). Keep `social_platform` as `('reddit', 'x', 'linkedin')` only — Google is a separate discoverability surface, not a social platform.

## What this plan does not include

- DDL. No `create table` statements are committed yet.
- Migration files. None.
- Supabase client code. None.
- RLS policies. Described separately in [rls-security-plan.md](./rls-security-plan.md).
- Auth schemas. Supabase auth provides `auth.users`.
- Stripe schemas. Deferred until billing is on the roadmap.

This document is the source of truth for what the schema will look like when migrations are written.
