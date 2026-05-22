# Migration phases

When Signal moves from mock data to Supabase, the migration ships in deliberate, narrowly-scoped phases. Each phase adds a small set of tables, lands behind RLS, and ships with the repository wiring that connects it to the existing UI.

The phases below are **future work**. Nothing in this doc is implemented today.

## Phase 10A — Core persistence

**Goal:** the founder can close the app and return to find their workspace, products, accounts, weekly plan, and approval history intact.

**Tables:**

- `workspaces`
- `workspace_members`
- `products`
- `growth_accounts`
- `weekly_plans`
- `weekly_plan_items`
- `approval_events`
- `backlog_items`
- `activity_events`
- `risk_events`
- `risk_snapshots`
- `audit_logs`
- `integration_statuses`

**Enums introduced:** `workspace_role`, `product_category`, `cta_style`, `risk_tolerance`, `social_platform`, `account_role`, `account_status`, `weekly_plan_status`, `plan_item_status`, `content_type`, `approval_action`, `risk_level`, `risk_category`, `activity_event_type`, `activity_entity_type`, `activity_layer`, `activity_severity`, `connection_status`.

**RLS:** workspace-scoped reads, role-gated writes, append-only enforced for `approval_events`, `activity_events`, `risk_events`, `audit_logs`.

**What not to include yet:** account setup kits (Phase B), insights and drafts (Phase C), content assets (Phase D), OAuth tokens (Phase F).

**Repository wiring (in the same phase):** `ProductRepository`, `AccountRepository`, `WeeklyPlanRepository`, `ApprovalRepository`, `BacklogRepository`, `ActivityRepository`, `RiskRepository`. See [mock-to-db-transition.md](./mock-to-db-transition.md).

**Rollback risk:** medium. Schema is straightforward but it does swap the data source for every page. Rollback path: keep the mock module behind a `SIGNAL_DATA_SOURCE` env var and route through `MockRepository` when set.

**Test checklist:**

- Workspace creation creates the owner row in `workspace_members`.
- Member can read their workspace; non-member cannot.
- Approve / reject / save-to-backlog produce `approval_events` rows.
- Redistribution writes `activity_events` and produces moves on `weekly_plan_items.scheduled_for`.
- Risk rescoring writes `risk_snapshots` per item.
- Append-only tables reject `update` and `delete`.

## Phase 10B — Account onboarding persistence

**Goal:** setup kits, checklists, and warm-up plans survive restarts; status transitions are auditable.

**Tables added:**

- `account_setup_profiles`
- `account_checklist_items`
- `account_warmup_plans`
- `account_status_history`

**Why now:** the founder onboarding flow only feels productized when progress persists. Without it, regenerating the kit is annoying and checklist toggles disappear.

**What not to include:** OAuth tokens (Phase F).

**Repository wiring:** extend `AccountRepository` with `getSetup(id)`, `setSetup(id, kit)`, `toggleChecklist(id, item_id)`, `regenerateKit(id)`. `account_status_history` writes flow through a trigger.

**Rollback risk:** low. Strictly additive.

**Test checklist:**

- Toggling a checklist item updates `account_checklist_items` atomically and `growth_accounts.readiness_score` recomputes on read.
- Status change inserts `account_status_history`.
- "Refresh kit" preserves done flags.

## Phase 10C — Content + comment intelligence persistence

**Goal:** insights, founder-edited drafts, and observed discussions survive restarts.

**Tables added:**

- `source_insights`
- `content_opportunities` (partial: only when status leaves `candidate`)
- `draft_variants` (partial: only saved or edited variants)
- `content_memory_records` (optional; only if cross-week reporting needs it)
- `discussion_opportunities`
- `comment_drafts` (partial)
- `reply_drafts` (partial)

**Enums introduced:** `insight_category`, `content_opportunity_kind`, `opportunity_impact`, `opportunity_status`, `tone_strength`, `cta_intensity`, `discussion_context`, `participation_recommendation`.

**Why now:** insights are founder-owned and have to persist. Discussions are observed-from-platform when APIs ship; until then the table acts as a manual queue.

**Repository wiring:** `InsightRepository`, `OpportunityRepository`, `DraftRepository`, `DiscussionRepository`, `CommentDraftRepository`.

**Rollback risk:** low. Pure-derivation engines keep producing rows; the database just makes them durable.

**Test checklist:**

- Insight creation appears in the library and in the opportunities engine on next run.
- Editing a draft variant bumps `version` and reads return the latest.
- Discussion seed → evaluation → recommendation chain still works with persisted rows.

## Phase 10D — Discoverability persistence

**Goal:** content assets are durable; discoverability opportunities can be pinned, deferred, or resolved.

**Tables added:**

- `content_assets`
- `discoverability_opportunities` (partial)
- `youtube_ideas` (partial)

**Optional materialized views:**

- `topical_clusters` (recompute via cron or trigger).
- `freshness_snapshots` (only if history matters).

**Enums introduced:** `content_asset_kind`, `discoverability_opportunity_kind`, `youtube_format_kind`.

**Rollback risk:** low.

**Test checklist:**

- Asset row reads compute freshness via the same `calculateFreshnessStatus` used in code today.
- Pinning an opportunity moves it from candidate to queued and persists.
- YouTube ideas seed-vs-edited distinction holds.

## Phase 10E — Tracking links + WebmasterID readiness

**Goal:** tracking links are real rows referenced from `weekly_plan_items.draft`. WebmasterID connection state is stored.

**Tables added:**

- `tracking_links`
- `campaign_attribution`
- `performance_events`
- `webmasterid_connections`

**Enums introduced:** none new.

**Why now:** real outbound links and attribution depend on this layer existing. Before this phase, links live as opaque ids inside the draft JSONB.

**Rollback risk:** low. Reads tolerate missing rows.

**Test checklist:**

- Tracking link creation respects product policy (utm_source = `signal`).
- Webmaster ID status transitions surface on the analytics readiness panel.
- Inserts to `performance_events` are restricted to the `service_role`.

## Phase 10F — OAuth connections

**Goal:** real OAuth across Reddit, X, LinkedIn. Encrypted token storage. Server-only token access.

**Tables added:**

- `platform_connections` (with encrypted columns).
- `scheduled_posts` (for actual publishing).

**Enums introduced:** `scheduled_post_status`.

**Detailed plan:** [oauth-token-storage-plan.md](./oauth-token-storage-plan.md).

**Why now:** the integration is the most invasive change. It needs the rest of the system stable.

**Rollback risk:** medium-high. OAuth callbacks are external dependencies; staged rollout per provider.

**Test checklist:**

- Connect happy path writes a `platform_connections` row and an `audit_logs` row.
- Refresh failure marks `error`; three consecutive failures escalate to `expired`.
- No client query returns encrypted columns.
- Revocation clears the encrypted columns and writes an `audit_logs` row.

## Phase 10G — SaaS readiness

**Goal:** multi-workspace SaaS, Stripe billing, invitations.

**Tables added:**

- `subscriptions`
- `usage_limits`
- `billing_customers`
- `team_invitations`
- `organization_settings`

**Why later:** none of this is on the roadmap for the foreseeable future. Listed for completeness.

## Cross-phase rules

- **Every phase ships behind a flag or an env var.** Rollback is a config change, not a revert.
- **The mock data source stays available** until a phase explicitly removes it (which won't happen for months).
- **Each table arrives with its RLS policies on the same migration.** No table ships with RLS off.
- **Append-only is enforced at the database**, not in application code.
- **Repositories are added in the same PR as the table.** The page doesn't change until the repository is wired.

## What none of these phases include

- **Supabase package installation.** Today's commits do not add it.
- **Auth implementation.** Phase A assumes Supabase auth is already configured; the schema is ready, the wiring is not.
- **Stripe integration.** Belongs to Phase 10G and only when billing is actually on the roadmap.
- **Mass migration of historical mock data.** Mock seeds become fixtures used in tests, not production seed data.

See [mock-to-db-transition.md](./mock-to-db-transition.md) for the repository-pattern plan that connects each phase to the existing UI without rewrites.
