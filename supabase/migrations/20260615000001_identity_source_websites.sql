-- Phase F7.0 — identity-level factual grounding.
--
-- Adds two nullable columns to growth_accounts so every publishing
-- identity can declare its canonical factual source(s). Generation
-- flows (Codex / MCP signal.generate_*) read these to ground post
-- ideas in the actual product/website rather than internal
-- infrastructure topics.
--
-- Columns
-- -------
--   source_website_url text     — primary website (https://… form)
--   reference_urls     text[]   — optional additional sources
--
-- Both nullable / default-empty so the migration is non-destructive
-- on every existing row. Active-identity enforcement lives in the
-- TypeScript validation layer (we want operator-facing error
-- messages, not Postgres CHECK violations).
--
-- Rollback
-- --------
--   alter table public.growth_accounts
--     drop column source_website_url,
--     drop column reference_urls;
--
-- No FKs, no triggers, no views, no RLS rule depends on the new
-- columns. Dropping is safe; data on the columns is metadata only.

set search_path = public;

alter table public.growth_accounts
  add column if not exists source_website_url text,
  add column if not exists reference_urls text[] not null default '{}'::text[];
