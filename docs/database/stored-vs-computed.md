# Stored vs computed

This document defines what Signal stores, what it derives, what is append-only, what is versioned, what is encrypted, and what is never stored.

The rules are deliberate. Storing what should be derived creates a sync problem; deriving what should be stored loses history.

## Stored (state of record)

Persist these as columns:

| Entity | Why store |
|---|---|
| Workspaces | Founder-created tenancy boundary. |
| Workspace members + roles | Required for RLS. |
| Products | Founder-authored profiles. |
| Growth accounts (status, handle, role, oauth flag) | Founder-managed identity. |
| Account setup kits | Founder-edited; expensive to regenerate. |
| Account checklist items | Per-item toggles need atomic writes. |
| Weekly plans | Plan identity per week. |
| Weekly plan items | The core operational unit. |
| Approval events | The decision log. |
| Backlog items | Held content with a reason. |
| Activity events | Operational timeline that must survive renders. |
| Source insights | Founder-observed reality. |
| Tracking links | Reservation contract for analytics. |
| Audit logs | Compliance + debugging. |
| Integration statuses | Reflects external system state. |
| Settings | Workspace-level configuration. |

## Computed (derived at read time)

Never store these as durable columns; compute on read:

| Computation | Where |
|---|---|
| `WeeklyPlan.status` | from items in the plan. |
| `GrowthAccount.readinessScore` | from `account_checklist_items`. |
| Platform readiness snapshot | from accounts. |
| Cadence load per platform | from `weekly_plan_items`. |
| `WeeklyPlanItem.risk` (live) | from drafts + accounts + items. (Snapshots are kept; see "snapshotted" below.) |
| `ContentMemorySummary` | from `weekly_plan_items` and `source_insights`. |
| Discoverability opportunities (raw scan) | from `content_assets` + `source_insights`. |
| Topical clusters | from `content_assets`. |
| Freshness verdict per asset | from `content_assets.updated_at` + amplification. |
| Activity timeline | when persisted, computed-on-write into `activity_events`; the dashboard reads cached rows. |
| Search index | computed each query. |
| Cadence callouts and "Next best actions" | recomputed per render. |
| Eligibility per account | from `account_status`. |

Storing any of these as columns means writing a refresher path for every mutation that touches an input. Cheaper to derive.

## Snapshotted (computed but stored periodically)

Sometimes we need both: a deterministic recomputation and a history of what the engine said at a point in time. These get a snapshot table.

| Snapshot | Pattern |
|---|---|
| `risk_snapshots` | One row per (plan_item_id, computed_at). Read uses the latest. History useful for audit. |
| `freshness_snapshots` (optional) | If WebmasterID data history matters. Not required for MVP. |
| `account_status_history` | Append-only transition log driven by trigger on `growth_accounts.status`. |

Snapshots are not the source of truth — the live computation is. They are a cache + audit trail.

## Append-only (no updates, no deletes)

| Table | Why append-only |
|---|---|
| `approval_events` | Decisions cannot be retroactively rewritten. |
| `activity_events` | Operational timeline must remain intact. |
| `risk_events` | Observed signals are facts; only `resolved_at` can move. |
| `account_status_history` | Lifecycle audit. |
| `audit_logs` | Compliance trail. |
| `performance_events` | Analytics facts. |

RLS denies `update` and `delete` for client roles on these tables. The service role inserts but does not modify.

## Versioned (history kept, latest read)

| Table | Pattern |
|---|---|
| `draft_variants` | `version smallint`; bumps on founder edit. Latest version per `opportunity_id` is read. |
| `comment_drafts`, `reply_drafts` | Same as `draft_variants`. |
| `risk_snapshots` | Implicit version by `computed_at`. |
| `account_status_history` | Implicit version via transitions. |

A separate version column beats a parallel "history" table when reads almost always want the latest.

## Encrypted (sensitive at rest)

Stored, but never readable by the client role:

| Field | Where |
|---|---|
| OAuth access tokens | `platform_connections.encrypted_access_token` |
| OAuth refresh tokens | `platform_connections.encrypted_refresh_token` |
| External API keys | `webmasterid_connections.encrypted_api_key`, future provider tokens. |

Encrypted with the Supabase Vault or a server-managed key. Access through server-side functions only. See [oauth-token-storage-plan.md](./oauth-token-storage-plan.md).

## Never stored

These never enter the database under any circumstance:

- Platform passwords.
- Cookies and browser session tokens.
- 2FA codes or recovery codes.
- Proxy fingerprints, anti-detect browser profiles.
- Raw email/password pairs for any service.
- Customer payment card data outside of Stripe.

This policy is structural. The schema does not even contain columns for these — there is no place to put them.

## Quick reference: where each field of `GrowthAccount` goes

- `id` → column.
- `workspaceId` → column.
- `productId` → column.
- `platform` → column (enum).
- `role` → column (enum).
- `handle` → column.
- `displayName` → column.
- `status` → column (enum). Transitions logged in `account_status_history`.
- `oauthConnected` → column (boolean). Source of truth is `platform_connections`; this is denormalized for fast reads.
- `readinessScore` → **computed** from `account_checklist_items`.
- `setup` → split into `account_setup_profiles.kit` (JSONB) + `account_checklist_items` (rows) + `account_warmup_plans` (JSONB).
- `createdAt`, `lastActivityAt` → columns.

## Quick reference: where each field of `WeeklyPlanItem` goes

- `id`, `planId`, `accountId`, `productId`, `platform`, `contentType` → columns.
- `draft` → `weekly_plan_items.draft` JSONB.
- `scheduledFor` → column.
- `status` → column (enum).
- `risk` → **computed** for reads, **snapshotted** into `risk_snapshots`. The `risk_snapshot` JSONB column on `weekly_plan_items` mirrors the latest snapshot for fast reads.

## What this policy never allows

- A column whose value drifts unless every mutation that affects it remembers to update it. (We use computed-on-read or triggers; never application discipline alone.)
- A "derived" cache that the UI also writes directly. Caches are written by triggers or server functions, never by the client.
- A column for "AI-generated reason" that drifts from the engine that produced it. Engine output is either snapshotted explicitly or recomputed.
