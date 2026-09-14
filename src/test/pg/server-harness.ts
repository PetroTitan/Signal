/**
 * A real PostgreSQL SERVER, with more than one backend.
 *
 * PGlite is genuine PostgreSQL, but it runs a single backend: two
 * simultaneous sessions do not exist, so a lock held by one transaction
 * can never be observed blocking another. That is a structural limit,
 * not a configuration one, and it means PGlite cannot prove the single
 * most important property of this subsystem — that two dispatchers
 * contending for the same quota serialise correctly.
 *
 * `embedded-postgres` downloads the official PostgreSQL binaries and
 * runs an ordinary server on a loopback port. No Docker, no system
 * install, and every connection is a real backend, so `for update`
 * really blocks and `skip locked` really skips.
 *
 * It is slower to start than PGlite (a few seconds for initdb), so the
 * PGlite suites remain the place for constraints, grants and RLS, and
 * this one is reserved for properties that need two sessions.
 */

import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { POSTGREST_GRANTS, SUPABASE_PRELUDE } from "./supabase-prelude";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");



export interface PgServerHarness {
  /** Loopback port the server listens on, for callers that pool. */
  port: number;
  /** Open an additional REAL connection. Each is its own backend. */
  connect: () => Promise<Client>;
  /** A connection already open, for setup. */
  admin: Client;
  close: () => Promise<void>;
}

// Each test file runs in its own worker and boots its own server. The
// first version picked a random base in a 120-port window per worker,
// which with seven such files collided on roughly one full run in six
// — the loser's start() failed and the whole file reported "Unknown
// Error". The block is now derived from the worker itself (pid, and
// thread id for a threads pool), so workers cannot overlap, and a port
// that is busy anyway (a server another process has not released yet)
// is skipped rather than fatal.
const PORT_BLOCK = 5;
let port =
  50000 + ((process.pid % 400) * (PORT_BLOCK * 5)) + ((threadId % 5) * PORT_BLOCK);

async function startServer(): Promise<{ server: EmbeddedPostgres; dir: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_BLOCK; attempt += 1) {
    const dir = mkdtempSync(path.join(tmpdir(), "signal-pg-"));
    port += 1;
    const server = new EmbeddedPostgres({
      databaseDir: dir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
    });
    try {
      await server.initialise();
      await server.start();
      return { server, dir };
    } catch (err) {
      lastError = err;
      try {
        await server.stop();
      } catch {
        // It never started.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error(
    `embedded PostgreSQL could not start on ${PORT_BLOCK} consecutive ports ending at ${port}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function createPgServerHarness(): Promise<PgServerHarness> {
  const { server, dir } = await startServer();

  const clients: Client[] = [];
  const connect = async (): Promise<Client> => {
    const c = new Client({
      host: "localhost",
      port,
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    await c.connect();
    clients.push(c);
    return c;
  };

  const admin = await connect();
  await admin.query(SUPABASE_PRELUDE);

  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await admin.query(sql);
    } catch (err) {
      throw new Error(
        `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await admin.query(POSTGREST_GRANTS);

  return {
    port,
    connect,
    admin,
    close: async () => {
      for (const c of clients) {
        try {
          await c.end();
        } catch {
          // A client already closed by a test is not an error here.
        }
      }
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ServerTenant {
  workspaceId: string;
  identityId: string;
  userId: string;
}

export async function seedServerTenant(
  db: Client,
  label: string,
): Promise<ServerTenant> {
  const user = await db.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1)
     returning id`,
    [`${label}@example.test`],
  );
  const userId = user.rows[0].id;

  const ws = await db.query<{ id: string }>(
    `insert into public.workspaces (name, slug, created_by)
     values ($1, $2, $3) returning id`,
    [`ws-${label}`, `ws-${label}`, userId],
  );
  const workspaceId = ws.rows[0].id;

  await db.query(
    `insert into public.workspace_members (workspace_id, user_id, role)
     values ($1, $2, 'owner')`,
    [workspaceId, userId],
  );

  const acct = await db.query<{ id: string }>(
    `insert into public.growth_accounts
       (workspace_id, platform, handle, display_name, status)
     values ($1, 'bluesky', $2, $2, 'active') returning id`,
    [workspaceId, `identity-${label}.bsky.social`],
  );

  return { workspaceId, identityId: acct.rows[0].id, userId };
}
