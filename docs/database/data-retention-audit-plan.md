# Data retention and audit plan

This document defines how long each kind of data lives, what happens on delete, and how Signal's audit trail is shaped. Practical and minimal — no legal overclaiming.

## Principles

- **Operational data is workspace-scoped.** Owners can delete their workspace; the deletion cascades.
- **Audit trail outlives operational data.** Audit logs persist for a longer window after workspace deletion, scrubbed of personal data.
- **Append-only tables don't get cleaned by founders.** They roll off via retention policies, not by hand.
- **Deletes are reversible for a grace window.** Soft-delete first, hard-delete on a schedule.

## Per-table retention

| Table | Default lifetime | On workspace delete | Cleanup |
|---|---|---|---|
| `workspaces` | indefinite | hard-deleted after 30-day grace | manual |
| `workspace_members` | indefinite | cascade delete | manual |
| `products` | indefinite | cascade soft-delete | retention 90 days post-archive |
| `growth_accounts` | indefinite | cascade soft-delete | retention 90 days post-archive |
| `account_setup_profiles` | indefinite | cascade | with account |
| `account_checklist_items` | indefinite | cascade | with account |
| `account_warmup_plans` | indefinite | cascade | with account |
| `account_status_history` | indefinite | cascade after 30-day grace | append-only |
| `platform_connections` | until revoked | cascade + token wipe | encrypted columns zeroed on delete |
| `weekly_plans` | 18 months | cascade | rolls off |
| `weekly_plan_items` | 18 months | cascade | rolls off |
| `approval_events` | 18 months | cascade | append-only |
| `backlog_items` | indefinite | cascade | manual |
| `activity_events` | 12 months | cascade | append-only; oldest pruned monthly |
| `risk_events` | 12 months | cascade | append-only |
| `risk_snapshots` | 6 months | cascade | append-only; oldest pruned monthly |
| `source_insights` | indefinite (archive on delete) | cascade soft-delete | retention 90 days post-archive |
| `content_opportunities` | 12 months | cascade | rolls off if status reaches `skipped` or `approved` |
| `draft_variants` | 18 months | cascade | rolls off; versions older than the latest after 12 months |
| `content_memory_records` | 12 months | cascade | rolls off |
| `discussion_opportunities` | 6 months | cascade | rolls off if recommendation was `skip` |
| `comment_drafts`, `reply_drafts` | 18 months | cascade | rolls off |
| `content_assets` | indefinite | cascade soft-delete | retention 90 days post-archive |
| `discoverability_opportunities` | 12 months | cascade | rolls off if `resolved_at` is set |
| `youtube_ideas` | 12 months | cascade | rolls off if `status` is `skipped` |
| `tracking_links` | indefinite | cascade soft-delete | retention 90 days post-archive |
| `campaign_attribution` | 24 months | cascade | append-only |
| `performance_events` | 24 months | cascade | append-only; oldest pruned monthly |
| `webmasterid_connections` | until revoked | cascade + key wipe | encrypted columns zeroed on delete |
| `audit_logs` | 36 months | survives workspace delete | scrubbed of PII after 18 months |
| `integration_statuses` | indefinite | cascade | manual |

## Workspace deletion flow

1. Owner triggers delete. The workspace is **soft-deleted** (`workspaces.deleted_at`).
2. For 30 days the workspace is read-only and recoverable by the owner.
3. At the 30-day mark, a background job hard-deletes the workspace and cascades to every workspace-scoped table.
4. Audit log rows retain a scrubbed pointer (`workspace_id`, `entity_type`, `action`, `occurred_at`) with PII removed.

## Account deletion flow

1. Owner deletes an account. The row is soft-deleted; the kit and warm-up plan are preserved.
2. After 30 days, `growth_accounts` and its onboarding tables hard-delete.
3. `platform_connections` for the account is **immediately** revoked on soft-delete (encrypted columns zeroed); the row itself is hard-deleted with the account.
4. `account_status_history` survives until the 30-day mark, then cascades.

## Export

When the workspace export feature ships (Phase F+), the export bundles:

- Every workspace-scoped table the owner has access to.
- Audit logs filtered to the workspace.
- A `manifest.json` with table versions and row counts.

Export does not include encrypted columns. Tokens are emitted as `<redacted>` placeholders.

## Audit trail shape

`audit_logs` is the cross-cutting audit table. It captures events the platform itself considers important:

- `workspace.created`, `workspace.deleted`, `workspace.restored`.
- `member.invited`, `member.joined`, `member.removed`, `member.role_changed`.
- `platform_connection.connected`, `platform_connection.refreshed`, `platform_connection.revoked`.
- `webmasterid_connection.connected`, `webmasterid_connection.revoked`.
- `settings.changed` (with the key being changed; the value is not logged if it carries sensitive content).
- `export.requested`, `export.completed`.
- `data.bulk_delete` (when a soft-delete cascade fires).

Each row carries `actor_user_id`, `occurred_at`, an `entity_type`, an `entity_id`, and a small `metadata` JSONB.

## PII scrubbing

After 18 months, the audit log scrubber:

- removes `actor_email` literals from any row (keeps `actor_user_id`).
- removes IP-address-like strings from `metadata`.
- removes URL query parameters that match typical sensitive patterns (`token`, `code`, `email`).

Scrubbed rows keep their identity (`id`, timestamps, action) so the audit trail remains complete for compliance review.

## Hard-delete vs anonymize

- **Hard-delete** removes the row and any direct payload (drafts, kits, content).
- **Anonymize** scrubs identifying fields while keeping the row for audit (logs only).
- The choice per table is in the table above.

## What this plan never does

- Promise specific compliance certifications. Signal does what good operational hygiene requires; certifications follow when there's a customer who requires one.
- Retain raw OAuth tokens after revocation.
- Retain payment card data outside of Stripe.
- Retain a row after an explicit hard-delete just for analytics.
- Treat the audit log as a marketing surface. The audit log is operational; it's never used to invent metrics.

## Implementation deferred

- Retention cron jobs land alongside Phase 10A.
- The PII scrubber lands alongside Phase 10G (SaaS readiness).
- Export ships when the first paying customer asks for it.

Until persistence lands, every row in this document is a future intent. Signal's mock module does not persist anything that needs to be retained.
