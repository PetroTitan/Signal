/**
 * A real-PostgreSQL fixture for unfollow worker and dispatcher tests.
 *
 * Every test in this directory runs the SHIPPED migrations against
 * PGlite and reaches them through `pgliteSupabase`, so the RPC bodies
 * under test are the ones that deploy. Nothing here reimplements a
 * predicate the production code also uses — a test cannot catch a bug
 * in logic it shares with its subject, and for a delete path that is
 * not a trade worth making.
 *
 * Multi-session behaviour is deliberately NOT claimed here. PGlite runs
 * a single backend. Locking, contention and deadlock live in
 * `two-session.pg.test.ts`, against a real server.
 */

import { vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "@/test/pg/harness";
import { pgliteSupabase } from "@/test/pg/supabase-adapter";

export const ACTOR_DID = "did:plc:unfollowoperator";
export const ACTOR_HANDLE = "operator.bsky.social";

export interface UnfollowFixture {
  h: PgHarness;
  db: PGlite;
  client: SupabaseClient;
  tenant: Tenant;
  close: () => Promise<void>;
}

export async function createUnfollowFixture(
  label: string,
): Promise<UnfollowFixture> {
  const h = await createPgHarness();
  const tenant = await seedTenant(h.db, label);
  return {
    h,
    db: h.db,
    client: pgliteSupabase(h.db),
    tenant,
    close: () => h.close(),
  };
}

export interface CampaignOptions {
  status?: string;
  dryRun?: boolean;
  requestedDailyQuota?: number;
  maxConsecutiveFailures?: number;
  minSuccessRatePercent?: number;
  timezone?: string;
  windowStart?: number;
  windowEnd?: number;
}

export async function makeUnfollowCampaign(
  f: UnfollowFixture,
  name: string,
  opts: CampaignOptions = {},
): Promise<string> {
  const r = await f.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, kind, status, dry_run,
        requested_daily_quota, max_consecutive_failures,
        min_success_rate_percent, timezone,
        execution_window_start_minute, execution_window_end_minute,
        created_by)
     values ($1,$2,$3,'unfollow',$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning id`,
    [
      f.tenant.workspaceId,
      f.tenant.identityId,
      name,
      opts.status ?? "active",
      opts.dryRun ?? false,
      opts.requestedDailyQuota ?? 100,
      opts.maxConsecutiveFailures ?? 50,
      opts.minSuccessRatePercent ?? 0,
      opts.timezone ?? "UTC",
      opts.windowStart ?? 0,
      opts.windowEnd ?? 1440,
      f.tenant.ownerId,
    ],
  );
  return r.rows[0].id;
}

export interface MemberSeed {
  did: string;
  sequence: number;
  /** The record identity the QUEUE holds. May deliberately be stale. */
  storedRkey?: string | null;
  storedUri?: string | null;
  storedCid?: string | null;
  status?: string;
  attemptCount?: number;
}

export async function makeMembers(
  f: UnfollowFixture,
  campaignId: string,
  seeds: MemberSeed[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const s of seeds) {
    const rkey = s.storedRkey === undefined ? `rk-${s.sequence}` : s.storedRkey;
    const uri =
      s.storedUri === undefined
        ? rkey
          ? `at://${ACTOR_DID}/app.bsky.graph.follow/${rkey}`
          : null
        : s.storedUri;
    const r = await f.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaign_members
         (workspace_id, campaign_id, subject_did, current_handle,
          import_sequence, status, attempt_count,
          provider_record_uri, provider_record_rkey, provider_record_cid,
          provider_record_source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               case when $9::text is null then null else 'list_records' end)
       returning id`,
      [
        f.tenant.workspaceId,
        campaignId,
        s.did,
        `${s.did.replace("did:plc:", "")}.bsky.social`,
        s.sequence,
        s.status ?? "queued",
        s.attemptCount ?? 0,
        uri,
        rkey,
        s.storedCid ?? null,
      ],
    );
    ids.push(r.rows[0].id);
  }
  return ids;
}

export async function makeRun(
  f: UnfollowFixture,
  campaignId: string,
  localDate: string,
  effectiveQuota = 100,
): Promise<string> {
  const r = await f.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaign_runs
       (workspace_id, campaign_id, local_date, status,
        requested_daily_quota, effective_daily_quota)
     values ($1,$2,$3,'running',$4,$5) returning id`,
    [f.tenant.workspaceId, campaignId, localDate, effectiveQuota, effectiveQuota],
  );
  return r.rows[0].id;
}

/**
 * A provider double that COUNTS what reached it.
 *
 * Every assertion in this suite is ultimately about one of these
 * numbers, because a delete count is the only figure that corresponds
 * to something happening to a real person's account.
 */
export interface ProviderDouble {
  fetchImpl: typeof fetch;
  deletes: { rkey: string; repo: string; collection: string; swap?: string }[];
  creates: unknown[];
  relationshipReads: number;
  listRecordCalls: number;
}

export interface ProviderScript {
  relationships?: Record<
    string,
    { following?: string | null; followedBy?: string | null }
  >;
  relationshipsFail?: { status: number; body?: unknown };
  deleteResponses?: Record<
    string,
    { status: number; body?: unknown; headers?: Record<string, string> }
  >;
  defaultDelete?: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  };
  listRecordPages?: {
    records: { uri: string; cid?: string; value: { subject: string } }[];
    cursor?: string | null;
  }[];
}

export function providerDouble(script: ProviderScript = {}): ProviderDouble {
  const state: ProviderDouble = {
    deletes: [],
    creates: [],
    relationshipReads: 0,
    listRecordCalls: 0,
    fetchImpl: (async () => new Response("{}")) as typeof fetch,
  };

  let listPage = 0;

  state.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();

    if (href.includes("getRelationships")) {
      state.relationshipReads += 1;
      if (script.relationshipsFail) {
        return new Response(JSON.stringify(script.relationshipsFail.body ?? {}), {
          status: script.relationshipsFail.status,
          headers: { "content-type": "application/json" },
        });
      }
      const parsed = new URL(href);
      const others = parsed.searchParams.getAll("others");
      return new Response(
        JSON.stringify({
          actor: ACTOR_DID,
          relationships: others.map((did) => {
            const rel = script.relationships?.[did];
            if (rel === undefined) {
              return { $type: "app.bsky.graph.defs#notFoundActor", actor: did };
            }
            return {
              $type: "app.bsky.graph.defs#relationship",
              did,
              ...(rel.following ? { following: rel.following } : {}),
              ...(rel.followedBy ? { followedBy: rel.followedBy } : {}),
            };
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (href.includes("listRecords")) {
      state.listRecordCalls += 1;
      const page = script.listRecordPages?.[listPage] ?? {
        records: [],
        cursor: null,
      };
      listPage += 1;
      return new Response(
        JSON.stringify({
          records: page.records,
          ...(page.cursor ? { cursor: page.cursor } : {}),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (href.includes("deleteRecord")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        repo: string;
        collection: string;
        rkey: string;
        swapRecord?: string;
      };
      state.deletes.push({
        rkey: body.rkey,
        repo: body.repo,
        collection: body.collection,
        swap: body.swapRecord,
      });
      const scripted =
        script.deleteResponses?.[body.rkey] ??
        script.defaultDelete ?? { status: 200, body: {} };
      return new Response(JSON.stringify(scripted.body ?? {}), {
        status: scripted.status,
        headers: { "content-type": "application/json", ...(scripted.headers ?? {}) },
      });
    }

    if (href.includes("createRecord")) {
      state.creates.push(init?.body);
      return new Response(JSON.stringify({ uri: "at://x/y/z", cid: "c" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  return state;
}

/** A resolved session that never refreshes, unless a test says so. */
export function mockSession(
  overrides: { refreshOnce?: () => Promise<unknown> } = {},
) {
  return {
    resolveRelationshipSession: vi.fn(async () => ({
      ok: true as const,
      actorDid: ACTOR_DID,
      actorHandle: ACTOR_HANDLE,
      accessJwt: "test-access-jwt-never-persisted",
      service: "https://bsky.social",
      connectionId: "conn-1",
      connectionStatus: "connected",
      tokenGeneration: 0,
      refreshOnce:
        overrides.refreshOnce ??
        (async () => ({
          ok: false as const,
          code: "session_expired" as const,
          message: "The Bluesky session has expired. Reconnect the account.",
        })),
    })),
  };
}
