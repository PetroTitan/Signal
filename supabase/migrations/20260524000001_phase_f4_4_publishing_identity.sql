-- Phase F4.4 — publishing identity.
--
-- Reframes growth_accounts from "OAuth row" toward "publishing
-- identity" by adding a free-form voice_profile column. The role
-- column is left in place for backward compatibility (older rows
-- already carry it; older code may still read it) but the founder
-- UI no longer exposes role and new accounts default role=null.
--
-- voice_profile is the single source of truth for "how this
-- identity writes". It's intentionally unstructured text so future
-- AI-assisted generation can read it verbatim without needing a
-- structured schema.

alter table public.growth_accounts
  add column if not exists voice_profile text;

comment on column public.growth_accounts.voice_profile is
  'Free-form description of how this publishing identity writes. Read by AI/MCP generation as canonical voice context.';

-- Backfill: copy `role` into voice_profile where voice_profile is
-- empty, so existing accounts get a sensible starting value. This
-- is non-destructive — role stays where it is. Older roles like
-- "founder" / "team" / "support" come across as a single-word
-- voice hint that the founder can rewrite at any time.
update public.growth_accounts
   set voice_profile = role
 where voice_profile is null
   and role is not null
   and length(trim(role)) > 0;
