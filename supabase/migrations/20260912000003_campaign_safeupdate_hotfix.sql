-- =====================================================================
-- Bluesky campaign dispatcher — pg-safeupdate compatibility
-- =====================================================================
--
-- Forward-only. Every earlier migration remains byte-identical.
--
-- Production enables Supabase's pg-safeupdate guard. The current
-- reserve_bluesky_campaign_quota function contains two unqualified
-- DELETE statements against its session-local temporary table. They are
-- logically safe (the table is private to this backend and bounded to one
-- chunk), but pg-safeupdate rejects them before the worker can reserve a
-- single member: "DELETE requires a WHERE clause".
--
-- Patch the installed function rather than copying its large body into a
-- second migration. The assertions make this fail closed if the preceding
-- definition ever differs from the exact state this hotfix was written for.

do $hotfix$
declare
  v_signature constant text :=
    'public.reserve_bluesky_campaign_quota(uuid,uuid,uuid,uuid,date,integer,integer,integer,integer,text)';
  v_definition text;
  v_repaired text;
  v_bare_count integer;
  v_guarded_count integer;
begin
  select pg_get_functiondef(to_regprocedure(v_signature))
    into v_definition;

  if v_definition is null then
    raise exception 'reserve_bluesky_campaign_quota is missing';
  end if;

  select count(*)::integer
    into v_bare_count
    from regexp_matches(
      v_definition,
      'delete\s+from\s+_claimed_members\s*;',
      'gi'
    );

  select count(*)::integer
    into v_guarded_count
    from regexp_matches(
      v_definition,
      'delete\s+from\s+_claimed_members\s+where\s+true\s*;',
      'gi'
    );

  if v_bare_count = 2 and v_guarded_count = 0 then
    v_repaired := regexp_replace(
      v_definition,
      'delete\s+from\s+_claimed_members\s*;',
      'delete from _claimed_members where true;',
      'gi'
    );
    execute v_repaired;
  elsif v_bare_count = 0 and v_guarded_count = 2 then
    -- A retried migration is already in the desired state.
    null;
  else
    raise exception
      'unexpected reserve_bluesky_campaign_quota cleanup shape: % bare, % guarded',
      v_bare_count,
      v_guarded_count;
  end if;
end
$hotfix$;

-- CREATE OR REPLACE preserves privileges, but restate the boundary so a
-- fresh database and a repaired production database prove the same state.
revoke all on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.reserve_bluesky_campaign_quota(
  uuid, uuid, uuid, uuid, date, integer, integer, integer, integer, text)
  to service_role;
