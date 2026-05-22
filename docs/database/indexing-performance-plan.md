# Indexing and performance plan

This document names the indexes Signal will create when each table lands. The motivation for each index is a real query pattern from a page or an engine.

No migrations are written yet; this is the design.

## Conventions

- Primary keys (`id uuid`) get a B-tree index automatically.
- Foreign keys are indexed individually for join performance.
- Composite indexes only when multiple query patterns share a leading column.
- JSONB columns: only indexed when an engine query needs to filter on a specific path; otherwise full-row reads are fine.

## Cross-cutting

Every workspace-scoped table has `workspace_id uuid not null` and a B-tree index on `(workspace_id)`. This index is the basis of RLS performance.

## Per-table indexes

### `workspace_members`

- Unique `(workspace_id, user_id)` — uniqueness + fast membership check.
- `(user_id)` — "my workspaces" lookups.

### `products`

- `(workspace_id, slug)` unique.
- `(workspace_id)` — products page.
- `(workspace_id, deleted_at)` — list excluding soft-deleted.

### `growth_accounts`

- `(workspace_id)` — accounts page.
- `(workspace_id, platform, status)` — platform command centers, eligibility queries.
- `(workspace_id, product_id)` — per-product list.

### `weekly_plans`

- `(workspace_id, week_start)` unique.
- `(workspace_id, status)` — dashboard active plan lookups.

### `weekly_plan_items`

- `(plan_id, status)` — approval queue + scheduler.
- `(account_id, scheduled_for)` — cadence + cooldown checks.
- `(workspace_id, scheduled_for)` — scheduler grid render.
- `(workspace_id, platform, status)` — platform command center queues.

### `approval_events`

- `(plan_item_id, occurred_at desc)` — item history view.
- `(workspace_id, occurred_at desc)` — activity timeline backfill.

### `backlog_items`

- `(workspace_id)` — backlog page.
- `(workspace_id, platform)` — platform command center backlog rail.
- `(workspace_id, moved_at desc)` — recently backlogged.

### `activity_events`

- `(workspace_id, occurred_at desc)` — `/activity` page.
- `(workspace_id, layer, occurred_at desc)` — layer-filtered activity view.
- `(workspace_id, severity, occurred_at desc)` — severity-filtered view.
- `(workspace_id, entity_type, entity_id)` — drill-down "history for this entity."

### `risk_events`

- `(workspace_id, detected_at desc)` — risk center default sort.
- `(workspace_id, level)` — risk-level filters.
- `(plan_item_id)` — per-item history.

### `risk_snapshots`

- `(plan_item_id, computed_at desc)` — latest snapshot per item.

### `audit_logs`

- `(workspace_id, occurred_at desc)` — admin audit view.
- `(actor_user_id, occurred_at desc)` — per-user history.

### `integration_statuses`

- Unique `(workspace_id, provider)`.

### Account onboarding

`account_setup_profiles` is keyed by `account_id` (1:1).

`account_checklist_items`:

- Unique `(account_id, item_id)`.
- `(account_id)` — render checklist per account.

`account_warmup_plans` is keyed by `account_id` (1:1).

`account_status_history`:

- `(account_id, occurred_at desc)` — lifecycle audit.

### `source_insights`

- `(workspace_id)` — insight library.
- `(workspace_id, product_id)` — per-product list.
- `(workspace_id, archived_at)` — exclude archived.

### `content_opportunities`

- `(workspace_id, status)` — `/opportunities` page.
- `(insight_id)` — drill-down by insight.

### `draft_variants`

- `(opportunity_id, version desc)` — latest variant.
- `(workspace_id)` — broad reads (rare).

### `discussion_opportunities`

- `(workspace_id, observed_at desc)` — `/discussions` page.
- `(workspace_id, platform, recommendation)` — platform + filter chip.

### `comment_drafts`, `reply_drafts`

- `(opportunity_id, version desc)` — latest draft per opportunity.

### `content_assets`

- `(workspace_id, product_id)` — per-product asset list.
- `(workspace_id, cluster)` — cluster reports.
- `(workspace_id, updated_at desc)` — freshness queries.

### `discoverability_opportunities`

- `(workspace_id, status)` — `/discoverability` page.
- `(asset_id)` — drill-down.

### `youtube_ideas`

- `(workspace_id, product_id, status)` — surface per product.

### `tracking_links`

- `(workspace_id, product_id)` — per-product links.
- `(signal_item_id)` — link-to-item lookup.

### `campaign_attribution`

- `(tracking_link_id)` unique — 1:1 with the link.

### `performance_events`

- `(workspace_id, occurred_at desc)` — analytics streams.
- `(tracking_link_id, occurred_at desc)` — per-link timelines.

### `webmasterid_connections`

- Unique `(workspace_id)`.

### `platform_connections`

- Unique `(account_id, provider)`.
- `(workspace_id, provider, status)` — connect-status overview.

### `scheduled_posts`

- `(plan_item_id)` unique-ish (one scheduled post per plan item).
- `(workspace_id, scheduled_for)` — upcoming queue.
- `(status, scheduled_for)` — publishing worker queue.

## Query patterns the indexes serve

### Dashboard

- "How many items pending approval?" → `(plan_id, status)`.
- "Top 4 upcoming approved items" → `(plan_id, status)` + sort by `scheduled_for`.
- "Recent activity (6 rows)" → `(workspace_id, occurred_at desc)`.
- "High-risk items in plan" → live join on `weekly_plan_items` filtered by risk JSONB; use the in-row `risk_snapshot` JSONB plus the `(plan_id, status)` index.
- "Eligible vs. in-setup accounts" → `(workspace_id, status)`.

### Approval queue

- "Pending items, ordered by scheduled time" → `(plan_id, status)` + sort.
- Risk filters reuse the same index; in-row `risk_snapshot.level` lets RLS-safe filtering happen without a separate join.

### Scheduler

- Week grid → `(workspace_id, scheduled_for)`.
- Per-account velocity → `(account_id, scheduled_for)`.
- Backlog rail → `(workspace_id, platform)` on `backlog_items`.

### Risk center

- Levels filter → `(workspace_id, level)`.
- Resolved/unresolved → `(workspace_id, resolved_at)` partial index (only if needed).

### Activity timeline

- Default view → `(workspace_id, occurred_at desc)`.
- Layer filter → `(workspace_id, layer, occurred_at desc)`.
- Severity filter → `(workspace_id, severity, occurred_at desc)`.

### Discoverability

- Freshness scan → `(workspace_id, updated_at desc)` + recompute in code.
- Cluster reports → `(workspace_id, cluster)`.

### Search

The `/search` page runs deterministic per-token scoring across rows. With persistence:

- Each table the search reads gets a `gin` index on a generated `tsvector` column over the searchable text fields (title, summary, body, etc.), or uses `pg_trgm` indexes for substring matching.
- The leading filter is always `workspace_id`, so the path is `(workspace_id) + tsvector match`.

## Materialized views (deferred)

Two computations are heavy enough to consider materializing later:

- `topical_clusters` per product. Refresh on `content_assets` insert/update.
- `weekly_plan_summary` (counts by status, risk, platform). Refresh on `weekly_plan_items` change.

Neither is in MVP Phase A. Both can be added without changing the schema.

## What this plan never does

- Adds an index "just in case." Every index has a named query.
- Indexes a JSONB column without a documented engine query that needs it.
- Pre-creates indexes for future SaaS features that aren't on the roadmap.

When a new query pattern emerges, the index is added in the same PR as the page that uses it, alongside a one-line note in this document.
