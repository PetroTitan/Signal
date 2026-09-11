/**
 * A REAL PostgreSQL for tests.
 *
 * PGlite is Postgres itself compiled to WebAssembly — not an emulation
 * and not a fake. `select version()` reports "PostgreSQL 18.3 (PGlite
 * …)", DDL is real DDL, constraints really reject, `FOR UPDATE SKIP
 * LOCKED` is the real planner node, roles and GRANT/REVOKE are real,
 * and RLS policies are evaluated by Postgres.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous milestone asserted RLS by reading the migration TEXT and
 * said so honestly, but a policy that parses is not a policy that
 * works. Three of the defects this hotfix repairs were invisible to
 * text inspection and would have been caught in one run against a real
 * server:
 *
 *   - `revoke all … from public` with no matching grant left
 *     service_role unable to execute the worker's own RPCs;
 *   - `ON CONFLICT (workspace_id)` cannot infer a PARTIAL unique index,
 *     so every workspace-global kill-switch write raised an error;
 *   - nothing tied a member's workspace to its campaign's.
 *
 * WHAT IT STILL IS NOT
 * --------------------
 * PGlite runs a single backend, so two genuinely simultaneous SESSIONS
 * are not available. Statement-level atomicity, locking clauses,
 * constraints, grants and RLS are all real; a two-connection race is
 * not. Where that matters the tests say which property they are
 * proving. See `docs/relationships/campaigns-hotfix.md`.
 */

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/**
 * The Supabase runtime objects a migration assumes exist.
 *
 * A bare Postgres has no `auth` schema and none of Supabase's roles, so
 * they are created here rather than the migrations being edited to
 * avoid them — the point is to run the REAL migration text.
 */
const SUPABASE_PRELUDE = `
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
const POSTGREST_GRANTS = `
grant select, insert, update, delete on all tables in schema public
  to anon, authenticated;
grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;
`;

export interface PgHarness {
  db: PGlite;
  /** Run as a signed-in user with a role in a workspace. */
  asUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>;
  /** Run as the worker. */
  asServiceRole: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Run as a bare database role (anon, authenticated) with no claims. */
  asRole: <T>(role: string, fn: () => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * Apply every migration in order, exactly as the repository ships them.
 *
 * Not a curated subset: applying only the campaign migrations would
 * miss an ordering or dependency problem, which is one of the things a
 * real run is for.
 */
export async function createPgHarness(): Promise<PgHarness> {
  // pgcrypto is loaded as a real contrib extension because the earliest
  // migration declares `create extension if not exists pgcrypto`. The
  // migrations are executed exactly as shipped — shimming around one
  // would mean testing something other than what deploys.
  const db = await PGlite.create({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_PRELUDE);

  for (const file of migrationFiles()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
    } catch (err) {
      throw new Error(
        `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await db.exec(POSTGREST_GRANTS);

  /**
   * Impersonate a signed-in user, exactly as PostgREST does.
   *
   * SESSION scope, not `set local`. `set local` is discarded at the end
   * of the enclosing transaction, and PGlite auto-commits each
   * statement — so the role reverted before the next query ran and
   * every RLS test passed for the wrong reason (as the superuser, which
   * bypasses RLS entirely). The `false` third argument to set_config is
   * the same distinction.
   */
  const asUser = async <T>(userId: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(
      `select set_config('request.jwt.claims',
         '{"sub":"${userId}","role":"authenticated"}', false);`,
    );
    await db.exec("set role authenticated;");
    try {
      return await fn();
    } finally {
      await db.exec("reset role;");
      await db.exec("select set_config('request.jwt.claims', '', false);");
    }
  };

  const asServiceRole = async <T>(fn: () => Promise<T>): Promise<T> => {
    await db.exec("set role service_role;");
    try {
      return await fn();
    } finally {
      await db.exec("reset role;");
    }
  };

  /**
   * Run as a bare role. The `finally` matters: a test that throws while
   * impersonating would otherwise leak the role into the NEXT test,
   * which then fails for an unrelated reason and sends the reader
   * hunting in the wrong place.
   */
  const asRole = async <T>(role: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`set role ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role;");
    }
  };

  return { db, asUser, asServiceRole, asRole, close: () => db.close() };
}

/** A workspace, an owner, an admin, a viewer and a Bluesky identity. */
export interface Tenant {
  workspaceId: string;
  ownerId: string;
  adminId: string;
  viewerId: string;
  identityId: string;
}

export async function seedTenant(
  db: PGlite,
  label: string,
): Promise<Tenant> {
  // Users first: workspaces.created_by is NOT NULL and references
  // auth.users, so the owner has to exist before the workspace does.
  const users: Record<string, string> = {};
  for (const role of ["owner", "admin", "viewer"]) {
    const u = await db.query<{ id: string }>(
      `insert into auth.users (email) values ($1) returning id`,
      [`${role}-${label}@example.test`],
    );
    users[role] = u.rows[0].id;
  }

  const w = await db.query<{ id: string }>(
    `insert into public.workspaces (name, created_by) values ($1, $2) returning id`,
    [`ws-${label}`, users.owner],
  );
  const workspaceId = w.rows[0].id;

  for (const role of ["owner", "admin", "viewer"]) {
    await db.query(
      `insert into public.workspace_members (workspace_id, user_id, role)
       values ($1, $2, $3)`,
      [workspaceId, users[role], role],
    );
  }

  const acct = await db.query<{ id: string }>(
    `insert into public.growth_accounts
       (workspace_id, platform, handle, display_name, status)
     values ($1, 'bluesky', $2, $2, 'active')
     returning id`,
    [workspaceId, `identity-${label}.bsky.social`],
  );

  return {
    workspaceId,
    ownerId: users.owner,
    adminId: users.admin,
    viewerId: users.viewer,
    identityId: acct.rows[0].id,
  };
}
