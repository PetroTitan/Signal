# Domain model audit

This document audits every TypeScript domain type currently in Signal and classifies which fields should become database columns, which should remain derived, and which are migration risks.

The goal is **clarity before code**. No Supabase package is installed; no migration is written.

## Audit scope

- [src/types/](../../src/types/)
- [src/core/](../../src/core/)
- [src/lib/mock/](../../src/lib/mock/)
- The store state in [src/core/store/reducer.ts](../../src/core/store/reducer.ts)

## Audit convention

For each entity:

- **TS type** — current TypeScript shape.
- **Used by** — which page(s) and engine(s) read it.
- **Stable fields** — survive renames and refactors; safe to store as columns.
- **Volatile fields** — change shape or value often; better as JSONB or derived.
- **Computed fields** — must stay derived; do not store.
- **Relationships** — foreign-key candidates.
- **Lifecycle** — status transitions worth tracking.
- **Migration concerns** — what to watch when persistence lands.

---

## Identity & tenancy

### `Workspace`

- **TS type:** `src/types/workspace.ts`
- **Used by:** every page indirectly (workspace name in topbar, philosophy in settings).
- **Stable:** `id`, `name`, `ownerName`, `ownerEmail`, `createdAt`, `philosophy`.
- **Volatile:** none.
- **Computed:** none.
- **Lifecycle:** single workspace today. Multi-workspace requires a `workspace_members` table.
- **Migration:** keep `ownerEmail` for now; replace with `owner_user_id` when Supabase auth lands.

### Users (implicit)

- **TS type:** none in the app today. The store carries `petro@helperg.com` as a literal actor string.
- **Migration:** Supabase auth.users provides identity; signal-level data references `auth.uid()` via `workspace_members`.

---

## Product system

### `ProductProfile`

- **TS type:** `src/types/product.ts`
- **Used by:** every adapter; the products page; the product detail page; risk engine.
- **Stable:** `id`, `slug`, `name`, `domain`, `category`, `positioning`, `contentStyle`, `ctaStyle`, `riskTolerance`.
- **Stable but list-typed:** `targetAudience: string[]`, `allowedCtaCopy: string[]`, `forbiddenClaims: string[]`, `preferredPlatforms: PlatformId[]`.
- **JSONB candidates:** `trackingMetadata` (utm_source, per-platform utm_medium map, campaign prefix).
- **Computed:** none on the row; opportunity scoring derives from it but is never stored on it.
- **Migration:** convert list-typed fields into JSONB or join tables. JSONB is simpler and sufficient.

---

## Account system

### `GrowthAccount`

- **TS type:** `src/types/account.ts`
- **Used by:** accounts list, account detail, weekly plan, platform command centers, scheduler, risk engine, comment engine.
- **Stable:** `id`, `workspaceId`, `productId`, `platform`, `role`, `handle`, `displayName`, `status`, `oauthConnected`, `createdAt`.
- **Volatile:** `lastActivityAt`.
- **Computed:** `readinessScore` (always recomputed from the checklist; do not persist as a column).
- **Lifecycle:** `planned → setup_needed → awaiting_manual_creation → ready_to_connect → connected → warming → active`, with `paused` as a side branch.
- **Migration concern:** the checklist sits inside the kit JSONB today. If split into rows, the readiness derivation needs both joined data on every read.

### `SetupKit` (aliased `AccountSetupProfile`)

- **TS type:** `src/types/account.ts`
- **JSONB candidate:** the entire kit is one logical document. Persist as `account_setup_profiles.kit JSONB` keyed by `account_id`.
- **Stable when split:** `ChecklistItem[]` could live as `account_checklist_items` rows so toggles are atomic and progress reports are SQL-able.
- **Lifecycle:** kit is regenerable. When the founder regenerates it, the rebuild merges existing `done` flags on matched `id`s.

### Eligibility helpers

- `ELIGIBLE_FOR_PLANNING`, `NOT_ELIGIBLE_FOR_PLANNING`, `isEligibleForPlanning(status)` — pure helpers. No persistence needed.

---

## Weekly operations

### `WeeklyPlan`

- **TS type:** `src/types/plan.ts`
- **Used by:** dashboard, weekly plan, approval queue, scheduler, store.
- **Stable:** `id`, `workspaceId`, `weekStartIso`, `weekEndIso`.
- **Computed:** `status` (derived from item counts).
- **Migration:** keep `status` as a column with a refresh path on item mutation, or derive on read with a view. Either is acceptable; column-with-refresh is simpler.

### `WeeklyPlanItem`

- **TS type:** `src/types/plan.ts`
- **Used by:** approval queue, scheduler, weekly plan, dashboard, risk engine.
- **Stable:** `id`, `planId`, `accountId`, `productId`, `platform`, `contentType`, `scheduledFor`, `status`.
- **JSONB candidate:** `draft` (hook, body, cta, trackingLinkId). The draft is a small document the founder edits as a unit.
- **Computed:** `risk` is rescored on every mutation. Persist the **snapshot** for audit (score, level, reasons, recommendation) but treat it as a derived field for read paths.
- **Lifecycle:** `draft → pending_approval → approved → scheduled → published`, with `rejected`, `backlog`, `paused`, `skipped` as side branches.
- **Migration:** see [stored-vs-computed.md](./stored-vs-computed.md) for the risk-snapshot policy.

### `BacklogItem`

- **TS type:** `src/types/plan.ts`
- **Used by:** backlog page, scheduler backlog rail, dashboard.
- **Stable:** `id`, `workspaceId`, `accountId`, `productId`, `platform`, `contentType`, `reason`, `movedAt`, `movedFromPlanItemId`.
- **JSONB:** `draft`, `risk` (a snapshot of the risk at backlog time).

### `ApprovalEvent`

- **TS type:** `src/types/approval.ts`
- **Used by:** approval queue, activity timeline.
- **Stable:** `id`, `planItemId`, `action`, `actorEmail`, `occurredAt`, optional `note`.
- **Append-only:** yes. Never updated; never deleted.

### `ScheduledPost`

- **TS type:** `src/types/scheduling.ts`
- **Used by:** today, only the type exists; runtime uses `WeeklyPlanItem.scheduledFor` directly.
- **Migration concern:** when publishing arrives, this becomes a real table with `attempt_count`, `last_error`, etc.

### `ActivityEvent`

- **TS type:** `src/types/activity.ts`
- **Used by:** `/activity`, dashboard "What changed this week" panel.
- **Stable:** `id`, `occurredAt`, `type`, `entityType`, `layer`, `platform`, `productId`, `severity`, `title`, `explanation`, `link`.
- **Append-only:** yes.
- **Migration concern:** today derived per render. When persisted, derivation runs server-side on writes; UI reads from the table.

---

## Risk and cadence

### `RiskEvent`

- **TS type:** `src/types/risk.ts`
- **Used by:** risk center; seed library.
- **Stable:** `id`, `category`, `level`, `accountId?`, `productId?`, `platform?`, `detectedAt`, `summary`, `recommendation`.
- **Append-only:** yes for observed events. A separate `risk_snapshots` table can store rescored item-level data.

### Cadence guidance

- **TS type:** `Platform.cadenceGuidance` is policy, not state. Lives in mock data today.
- **Migration:** can stay as a code constant. Only persist if customers are allowed to edit cadence policy per workspace.

---

## Content intelligence

### `SourceInsight`

- **TS type:** `src/types/content-intelligence.ts`
- **Used by:** content intelligence page, opportunities page, comment intelligence engine.
- **Stable:** `id`, `workspaceId` (to add), `productId`, `title`, `coreInsight`, `summary`, `category`, `sourceType`, `riskLevel`, `createdAt`.
- **JSONB candidate:** `audience: InsightAudience[]`, `platformFit` (per-platform fit map).
- **Numeric (small integer):** `discoverabilityPotential`, `evergreenScore`, `conversationScore`, `freshnessPotential` (0–100).

### `ContentOpportunity`

- **TS type:** `src/types/content-intelligence.ts`
- **Used by:** opportunities page, content intelligence page.
- **Migration consideration:** opportunities are **derived** on render today. Persist only **founder-curated** opportunities (those that were edited, approved, or queued). Pure derivation should stay computed.

### `DraftVariant`

- **TS type:** `src/types/content-intelligence.ts`
- **Used by:** content intelligence page, approval queue (after a draft becomes an item).
- **Migration:** persist only **selected** variants. The other variants are output of pure functions; storing all of them creates noise.

### `ContentMemoryRecord`

- **TS type:** `src/types/content-intelligence.ts`
- **Migration:** can stay derived if usage history is reconstructible from `weekly_plan_items`. Persist only if cross-week reporting needs it.

### `GuardrailFlag`

- **TS type:** `src/types/content-intelligence.ts`
- **Migration:** enum union. No standalone table.

---

## Comment intelligence

### `DiscussionOpportunity`

- **TS type:** `src/types/comment-intelligence.ts`
- **Used by:** discussions page, comments page, activity timeline, dashboard.
- **Migration:** persist as observed-from-platform rows when real APIs ship. Today they're seeded; evaluation is pure.
- **JSONB:** `participation` (freshness/audience match/noise), `communityFit` (level + reason), `topicTags`, `matchedInsightIds`.

### `CommentDraft` / `ReplyDraft`

- **TS type:** `src/types/comment-intelligence.ts`
- **Migration:** persist only when the founder explicitly saves a draft. Generated drafts that were not used should not persist by default.
- **JSONB:** `guardrailFlags`, `risk`.

### `ConversationRisk`

- **TS type:** `src/types/comment-intelligence.ts`
- **Migration:** snapshot stored alongside the draft as JSONB. Recomputed on edit.

---

## Discoverability

### `ContentAsset`

- **TS type:** `src/types/discoverability.ts`
- **Used by:** `/discoverability`, `/platforms/google`, opportunities engine.
- **Stable:** `id`, `workspaceId` (to add), `productId`, `cluster`, `kind`, `url`, `title`, `summary`, `publishedAt`, `updatedAt`, `indexed`, `mockSearchPosition`.
- **JSONB candidates:** `internalLinks`, `amplification`, `notes`.
- **Computed:** `freshness` (always reapplied via `calculateFreshnessStatus`).

### `DiscoverabilityOpportunity`

- **TS type:** `src/types/discoverability.ts`
- **Migration:** derived today; persist only when the founder pins, defers, or resolves an opportunity.

### `TopicalCluster`, `FreshnessSnapshot`, `SearchVisibilitySnapshot`

- **Migration:** computed. Optional materialized views or table-level caches in the future.

### `YouTubeIdea`, `YouTubeCadencePlan`

- **TS type:** `src/types/discoverability.ts`
- **Migration:** persist if the founder edits ideas. Default-generated ideas can stay computed.

---

## Analytics / WebmasterID

### `TrackingLink`

- **TS type:** `src/types/analytics.ts`
- **Used by:** weekly plan items reference `trackingLinkId`.
- **Stable:** `id`, `productId`, `accountId`, `platform`, `signalCampaignId`, `signalItemId`, `utmSource`, `utmMedium`, `utmCampaign`, `destinationUrl`, `createdAt`.
- **Migration concern:** today references are by ID but no real link records exist. Persist as soon as WebmasterID is wired.

### `PerformanceMetric`

- **TS type:** `src/types/analytics.ts`
- **Migration:** placeholder. Live data is the WebmasterID stream.

---

## Command-center policy

### `PlatformStrategy`, `PlatformCadencePolicy`, `PlatformContentFormat`, `PlatformRiskRule`, `PlatformPlaybook`

- **TS type:** `src/types/command-center.ts`
- **Migration:** code-resident policy. Do not persist unless customers can author per-workspace policy.

---

## System

### Settings, audit logs, integration statuses

- Not yet typed in the app. Planned in [supabase-schema-plan.md](./supabase-schema-plan.md):
  - `audit_logs` — append-only.
  - `integration_statuses` — per-workspace per-provider status row.
  - `settings` — workspace-scoped key/value JSONB rows or columns on `workspaces`.

---

## Cross-cutting observations

1. **`workspace_id` is missing from many types today.** A single-workspace mock doesn't need it. Multi-workspace persistence makes it required on every row. The audit notes this entity-by-entity.
2. **`actorEmail` should become `actor_user_id`.** Today it's a literal string. Persist email as a fallback; resolve via `auth.uid()` once Supabase auth ships.
3. **Derived snapshots vs computed reads.** Several entities (risk, freshness, content memory, topical clusters) are computed today and should stay computed. Persisting them as columns creates a sync problem. Use materialized views or compute-on-read instead.
4. **Lifecycle bookkeeping.** Account status, plan-item status, opportunity status — all benefit from append-only history tables (`account_status_history`, etc.) so audit trails are clean.

This audit is the input to [entity-classification.md](./entity-classification.md), [supabase-schema-plan.md](./supabase-schema-plan.md), and [stored-vs-computed.md](./stored-vs-computed.md).
