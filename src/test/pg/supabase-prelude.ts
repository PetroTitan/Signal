/**
 * The Supabase runtime objects a migration assumes exist.
 *
 * A bare Postgres has no `auth` schema, no `storage` schema and none of
 * Supabase's roles, so they are created here rather than the migrations
 * being edited to avoid them — the point is to run the REAL migration
 * text.
 *
 * Shared by BOTH real-Postgres harnesses. It used to be copied into
 * each, and the copies drifted: the second harness's `storage.buckets`
 * was missing `file_size_limit`, so a migration that applies fine in
 * one harness failed in the other. One definition, two callers.
 */
export const SUPABASE_PRELUDE = `
create schema if not exists auth;

-- Supabase's auth.uid() reads the request JWT. Tests set it with
-- set_config('request.jwt.claims', …) exactly as PostgREST does.
-- nullif BEFORE the cast: clearing the setting leaves an empty string,
-- and ''::jsonb raises "invalid input syntax for type json" rather than
-- returning null. Supabase's own definition is null-safe the same way.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid;
$$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

-- Supabase's storage schema. An early migration creates a bucket and
-- RLS policies on storage.objects; those objects are provided by the
-- platform, not by any migration in this repository, so the minimum
-- surface they reference is created here.
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid
);

alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[] language sql immutable as $fn$
  select string_to_array(name, '/');
$fn$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon')
    then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated')
    then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role')
    then create role service_role nologin noinherit bypassrls; end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
`;

/**
 * Grants PostgREST issues for every table so that RLS — not a missing
 * privilege — is what decides. Without these an RLS test would pass for
 * the wrong reason: the role would be refused before a policy ran.
 */
export const POSTGREST_GRANTS = `
grant select, insert, update, delete on all tables in schema public
  to anon, authenticated;
grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;
`;
