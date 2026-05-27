-- Phase: creative readiness — repair prompt-only "generated" rows.
--
-- Production audit (2026-05-27) found 7 of 9 weekly_plan_item_creatives
-- rows persisted as:
--
--   source_type = 'generated'
--   asset_url   IS NULL
--   source_url  IS NULL
--   storage_path IS NULL
--   status      ∈ {'pending_review', 'approved'}
--
-- That is the false-ready state: a prompt-only creative pretending to
-- be a real media asset. The post-fix MCP attach handler refuses to
-- create rows in this shape (`validateAttachInput`), and the
-- repository-level publish gate (`creativeReadinessReason`) now
-- consults `storage_path` too — so no new occurrences will be
-- written. This migration repairs the existing rows.
--
-- Repair strategy (non-destructive, idempotent):
--   - Downgrade `source_type` to 'planned' so the row is treated as
--     a placeholder by every read path.
--   - Reset `status` to 'planned' so review surfaces don't show a
--     misleading "Pending review" / "Approved" badge for a row that
--     has no asset.
--   - Stamp `metadata.downgraded_at` + `metadata.downgraded_from` so
--     the audit trail records the change. The prompt + alt text +
--     metadata are preserved (the operator may still want them).
--   - The migration is a single UPDATE with a tight WHERE — running
--     it twice is a no-op (the second pass has no matching rows).
--
-- Scope discipline (per the creative-readiness PR brief):
--   - No schema changes (no ALTER TABLE).
--   - Touches only `weekly_plan_item_creatives` rows that match the
--     exact bad-state shape.
--   - No publish_history, execution_items, or scheduler-adjacent
--     tables touched.
--
-- Rollback: there is no direct inverse. The original `source_type`
-- and `status` values were ambiguous by design (every row in this
-- set was already broken). If a row needs to be re-promoted to
-- `generated`, the operator must re-attach a real asset via the
-- MCP attach flow, which now refuses prompt-only `generated` at
-- the boundary.

UPDATE weekly_plan_item_creatives
SET
  source_type = 'planned',
  status      = 'planned',
  metadata    = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'downgraded_at',       now()::text,
                       'downgraded_from',     jsonb_build_object(
                                                'source_type', source_type,
                                                'status',      status
                                              ),
                       'downgrade_reason',    'prompt_only_generated_without_asset',
                       'downgrade_migration', '20260527000001'
                     )
WHERE source_type = 'generated'
  AND (asset_url   IS NULL OR length(trim(asset_url))   = 0)
  AND (source_url  IS NULL OR length(trim(source_url))  = 0)
  AND (storage_path IS NULL OR length(trim(storage_path)) = 0);
