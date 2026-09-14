/**
 * A real-PostgreSQL fixture for FOLLOW campaign incident regressions.
 *
 * Runs the SHIPPED migrations against PGlite and reaches them through
 * `pgliteSupabase`, so every RPC under test is the one that deploys.
 *
 * THE SESSION IS REAL TOO. A `platform_connections` row holds tokens
 * encrypted with the real cipher, `resolveRelationshipSession` decrypts
 * them, and `refreshOnce` performs the real `performRefresh` — reading
 * the stored refresh token, calling the provider double's
 * `refreshSession`, persisting the rotated pair through
 * `upsertPlatformConnection`, and marking the connection expired on
 * failure through `markExpired`. That is the only way to assert what
 * ACCOUNTS shows after a refresh, because that is where Accounts reads.
 *
 * Nothing here is mocked except the network.
 */

import { randomBytes } from "node:crypto";

// The cipher reads the key ONCE, lazily, on first use. Set it before
// anything in this process can ask for it.
if (!process.env.TOKEN_ENCRYPTION_KEY) {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64url");
}

import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "@/test/pg/harness";
import { pgliteSupabase } from "@/test/pg/supabase-adapter";
import { getTokenCipher } from "@/core/platform-oauth";

export const ACTOR_DID = "did:plc:incidentoperator";
export const ACTOR_HANDLE = "webmasterid.bsky.social";

export interface FollowFixture {
  h: PgHarness;
  db: PGlite;
  client: SupabaseClient;
  tenant: Tenant;
  connectionId: string;
  close: () => Promise<void>;
}

export async function createFollowFixture(label: string): Promise<FollowFixture> {
  const h = await createPgHarness();
  const tenant = await seedTenant(h.db, label);
  const cipher = getTokenCipher();
  if (!cipher.isAvailable()) throw new Error("token cipher unavailable in test");

  // The identity's DECLARED handle must be the one the provider returns
  // from refreshSession, or the real drift check refuses the refreshed
  // session — correctly. The first draft of this fixture left the seed
  // handle in place and every refresh was refused as a handle mismatch.
  await h.db.query(
    `update public.growth_accounts
        set connection_status = 'connected', handle = $2
      where id = $1`,
    [tenant.identityId, ACTOR_HANDLE],
  );
  const conn = await h.db.query<{ id: string }>(
    `insert into public.platform_connections
       (workspace_id, account_id, platform, provider_account_id, handle,
        display_name, connection_status, health_status,
        access_token_encrypted, refresh_token_encrypted, connected_at)
     values ($1,$2,'bluesky',$3,$4,$4,'connected','healthy',$5,$6, now())
     returning id`,
    [
      tenant.workspaceId, tenant.identityId, ACTOR_DID, ACTOR_HANDLE,
      cipher.encrypt("jwt-OLD"), cipher.encrypt("refresh-1"),
    ],
  );

  return {
    h,
    db: h.db,
    client: pgliteSupabase(h.db),
    tenant,
    connectionId: conn.rows[0].id,
    close: () => h.close(),
  };
}

/** Which plaintext tokens the connection row currently holds. */
export async function storedTokens(f: FollowFixture): Promise<{
  access: string | null;
  refresh: string | null;
  status: string;
  accountStatus: string;
}> {
  const cipher = getTokenCipher();
  const r = await f.db.query<{ a: string | null; r: string | null; s: string }>(
    `select access_token_encrypted as a, refresh_token_encrypted as r,
            connection_status as s
       from public.platform_connections where id = $1`,
    [f.connectionId],
  );
  const g = await f.db.query<{ s: string }>(
    `select connection_status as s from public.growth_accounts where id = $1`,
    [f.tenant.identityId],
  );
  return {
    access: r.rows[0].a ? cipher.decrypt(r.rows[0].a) : null,
    refresh: r.rows[0].r ? cipher.decrypt(r.rows[0].r) : null,
    status: r.rows[0].s,
    accountStatus: g.rows[0].s,
  };
}

/** Put the connection back the way a reconnect on Accounts would. */
export async function reconnectAccount(f: FollowFixture, access: string, refresh: string) {
  const cipher = getTokenCipher();
  await f.db.query(
    `update public.platform_connections
        set connection_status = 'connected', health_status = 'healthy',
            access_token_encrypted = $2, refresh_token_encrypted = $3
      where id = $1`,
    [f.connectionId, cipher.encrypt(access), cipher.encrypt(refresh)],
  );
  await f.db.query(
    `update public.growth_accounts set connection_status = 'connected' where id = $1`,
    [f.tenant.identityId],
  );
}

export async function makeFollowCampaign(
  f: FollowFixture,
  name: string,
  opts: {
    status?: string;
    requestedDailyQuota?: number;
    timezone?: string;
    windowStart?: number;
    windowEnd?: number;
    maxConsecutiveFailures?: number;
  } = {},
): Promise<string> {
  const r = await f.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, kind, status,
        requested_daily_quota, max_consecutive_failures, min_success_rate_percent,
        timezone, execution_window_start_minute, execution_window_end_minute,
        created_by)
     values ($1,$2,$3,'follow',$4,$5,$6,0,$7,$8,$9,$10) returning id`,
    [
      f.tenant.workspaceId, f.tenant.identityId, name,
      opts.status ?? "active", opts.requestedDailyQuota ?? 400,
      opts.maxConsecutiveFailures ?? 50,
      opts.timezone ?? "UTC", opts.windowStart ?? 0, opts.windowEnd ?? 1440,
      f.tenant.ownerId,
    ],
  );
  return r.rows[0].id;
}

/** Bulk-insert members `did:plc:<prefix><n>` with import_sequence 1..n. */
export async function makeMembers(
  f: FollowFixture,
  campaignId: string,
  count: number,
  prefix = "m",
): Promise<void> {
  const CHUNK = 2000;
  for (let start = 1; start <= count; start += CHUNK) {
    const values: string[] = [];
    for (let i = start; i < Math.min(start + CHUNK, count + 1); i += 1) {
      values.push(
        `('${f.tenant.workspaceId}','${campaignId}','did:plc:${prefix}${i}','${prefix}${i}.bsky.social',${i})`,
      );
    }
    await f.db.query(
      `insert into public.bluesky_follow_campaign_members
         (workspace_id, campaign_id, subject_did, current_handle, import_sequence)
       values ${values.join(",")}`,
    );
  }
}

// =====================================================================
// The provider double
// =====================================================================

export type CreateRecordScript = (call: {
  index: number;
  token: string;
  subjectDid: string;
}) => { status: number; body?: unknown; headers?: Record<string, string> };

export interface ProviderScript {
  /** DID → following? (default: not following). */
  following?: Set<string>;
  /** Decide each createRecord. Default: 200 for any token but jwt-OLD. */
  createRecord?: CreateRecordScript;
  /** Decide each refreshSession. Default: rotate to jwt-NEW / refresh-2. */
  refreshSession?: (call: { index: number; refreshToken: string }) =>
    | { ok: true; accessJwt: string; refreshJwt: string }
    | { ok: false; status: number; body?: unknown };
  /** Decide getSession probes. Default: 200 unless token is jwt-OLD. */
  getSession?: (token: string) => { status: number; body?: unknown };
  relationshipsFail?: boolean;
}

export interface ProviderDouble {
  fetchImpl: typeof fetch;
  calls: {
    createRecord: number;
    refreshSession: number;
    getSession: number;
    getRelationships: number;
  };
  /** Every createRecord, in order: the bearer token and the subject. */
  createRecords: { token: string; subjectDid: string }[];
  refreshTokensUsed: string[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function providerDouble(script: ProviderScript = {}): ProviderDouble {
  const state: ProviderDouble = {
    fetchImpl: (async () => json({})) as typeof fetch,
    calls: { createRecord: 0, refreshSession: 0, getSession: 0, getRelationships: 0 },
    createRecords: [],
    refreshTokensUsed: [],
  };
  let recordSeq = 0;

  state.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    const headers = new Headers(init?.headers ?? {});
    const auth = headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");

    if (href.includes("getRelationships")) {
      state.calls.getRelationships += 1;
      if (script.relationshipsFail) return json({ error: "InternalServerError" }, 500);
      const others = new URL(href).searchParams.getAll("others");
      return json({
        actor: ACTOR_DID,
        relationships: others.map((did) => ({
          $type: "app.bsky.graph.defs#relationship",
          did,
          ...(script.following?.has(did)
            ? { following: `at://${ACTOR_DID}/app.bsky.graph.follow/pre-${did.slice(-6)}` }
            : {}),
        })),
      });
    }

    if (href.includes("refreshSession")) {
      state.calls.refreshSession += 1;
      state.refreshTokensUsed.push(token);
      const verdict = script.refreshSession
        ? script.refreshSession({ index: state.calls.refreshSession, refreshToken: token })
        : { ok: true as const, accessJwt: "jwt-NEW", refreshJwt: "refresh-2" };
      if (!verdict.ok) return json(verdict.body ?? { error: "ExpiredToken" }, verdict.status);
      return json({
        did: ACTOR_DID,
        handle: ACTOR_HANDLE,
        accessJwt: verdict.accessJwt,
        refreshJwt: verdict.refreshJwt,
      });
    }

    if (href.includes("getSession")) {
      state.calls.getSession += 1;
      const verdict = script.getSession
        ? script.getSession(token)
        : token === "jwt-OLD"
          ? { status: 400, body: { error: "ExpiredToken", message: "Token has expired" } }
          : { status: 200 };
      if (verdict.status !== 200) return json(verdict.body ?? {}, verdict.status);
      return json({ did: ACTOR_DID, handle: ACTOR_HANDLE, active: true });
    }

    if (href.includes("createRecord")) {
      state.calls.createRecord += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        record?: { subject?: string };
      };
      const subjectDid = body.record?.subject ?? "";
      state.createRecords.push({ token, subjectDid });
      const verdict = script.createRecord
        ? script.createRecord({ index: state.calls.createRecord, token, subjectDid })
        : token === "jwt-OLD"
          ? { status: 400, body: { error: "ExpiredToken", message: "Token has expired" } }
          : { status: 200 };
      if (verdict.status === 200 && verdict.body === undefined) {
        recordSeq += 1;
        return json({
          uri: `at://${ACTOR_DID}/app.bsky.graph.follow/rk${recordSeq}`,
          cid: `cid${recordSeq}`,
        });
      }
      return json(verdict.body ?? {}, verdict.status, verdict.headers);
    }

    return json({});
  }) as typeof fetch;

  return state;
}

// =====================================================================
// Readers
// =====================================================================

export const campaignRow = async (f: FollowFixture, id: string) =>
  (await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaigns where id = $1`, [id],
  )).rows[0];

export const runsFor = async (f: FollowFixture, id: string) =>
  (await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaign_runs
      where campaign_id = $1 order by local_date`, [id],
  )).rows;

export const memberCounts = async (f: FollowFixture, id: string) => {
  const r = await f.db.query<{ status: string; n: string }>(
    `select status, count(*)::text as n from public.bluesky_follow_campaign_members
      where campaign_id = $1 group by status`, [id],
  );
  return Object.fromEntries(r.rows.map((x) => [x.status, Number(x.n)]));
};

export const actionsFor = async (f: FollowFixture, id: string) =>
  (await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_relationship_actions
      where campaign_id = $1 order by created_at, id`, [id],
  )).rows;

export const intentsFor = async (f: FollowFixture, id: string) =>
  Number((await f.db.query<{ n: string }>(
    `select count(*)::text as n from public.bluesky_campaign_attempt_ledger l
       join public.bluesky_follow_campaign_members m on m.id = l.member_id
      where m.campaign_id = $1 and l.provider_intent_at is not null`, [id],
  )).rows[0].n);

export const conservation = async (f: FollowFixture, id: string) =>
  (await f.db.query<Record<string, string>>(
    `select * from public.bluesky_campaign_conservation($1, $2)`,
    [f.tenant.workspaceId, id],
  )).rows[0];
