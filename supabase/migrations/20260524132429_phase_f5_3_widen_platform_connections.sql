-- Phase F5.3 — widen platform_connections.platform CHECK constraint.
--
-- The original constraint allowed only the OAuth-capable platforms
-- ('reddit', 'x', 'linkedin'). With the api_key_verify Connect-Identity
-- flow, Bluesky (and in follow-ups dev.to / Hashnode / Telegram)
-- also persist per-identity rows on this table after handle
-- verification.
--
-- This migration is purely additive:
--   - Drops the old CHECK
--   - Recreates a wider CHECK that includes the api_key_verify
--     platforms
--   - No data is moved, no columns are altered, no rows are touched
--
-- The wider list intentionally includes all four api_key_verify
-- platforms even though only the Bluesky verifier ships in this PR.
-- Reserving the constraint up front avoids a follow-up DDL per
-- platform.

set search_path = public;

alter table public.platform_connections
  drop constraint if exists platform_connections_platform_check;

alter table public.platform_connections
  add constraint platform_connections_platform_check
  check (
    platform in (
      'reddit',
      'x',
      'linkedin',
      'bluesky',
      'devto',
      'hashnode',
      'telegram'
    )
  );
