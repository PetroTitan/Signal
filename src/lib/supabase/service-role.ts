import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "./env";

/**
 * Phase F0 — server-only service-role client.
 *
 * Scope is intentionally narrow: this client is used only by audited
 * server-side workers and by server actions after they independently
 * authenticate and authorize the operator. Those paths do not have a
 * user cookie whose RLS role can execute worker-only RPCs.
 *
 * Discipline:
 *
 *   - Never import this from a client component.
 *   - Never expose the returned client to the browser.
 *   - Never log the key.
 *   - When SUPABASE_SERVICE_ROLE_KEY is unset, the function returns
 *     null and the MCP route returns 503 — no silent fallback.
 *
 * Every consumer must enforce its own authorization boundary and scope
 * each query to the authorized workspace_id.
 */
/**
 * The ONE transport every service-role request goes through.
 *
 * PRODUCTION, 2026-09-15 15:35:47Z (Vercel request
 * 7ggxw-1789486547108-3213ab3ab693). supabase-js speaks PostgREST over
 * the global `fetch`. Inside a Next.js route handler that is Next's
 * patched fetch, and its Data Cache decision for a request that carries
 * no `cache` directive is "auto cache" unless the route's request store
 * has `revalidate = 0` — which a GET-only route handler never sets
 * (`export const dynamic = "force-dynamic"` only flags the route; the
 * store's revalidate is set to 0 only for routes with non-GET methods).
 * The client's `Authorization` header does not help either: the "auto
 * no cache" rule for authorised requests also requires `revalidate === 0`.
 * So every read the campaign dispatcher made was keyed and stored in
 * the persistent Data Cache, across invocations: a worker read token
 * generation N after another invocation had committed N+1, was told
 * to reload, and reloaded the same cached row. (A 200-answering PATCH
 * was replayed the same way.)
 *
 * This wrapper forces `cache: "no-store"` on every request the client
 * makes. It preserves every other RequestInit field (method, headers,
 * body, signal, …) untouched and resolves the GLOBAL fetch at call
 * time, so a runtime that patches `fetch` (Next) and a test that swaps
 * it both see it. It never inspects, logs or copies the key, the
 * Authorization header or a response body.
 */
export function noStoreFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, { ...(init ?? {}), cache: "no-store" });
}

export function createSupabaseServiceRoleClient() {
  const env = readSupabaseEnv();
  if (!env) return null;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) return null;
  return createClient(env.url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        "x-signal-service-role": "signal-server-worker",
      },
      // Never the platform's cached fetch. See `noStoreFetch`.
      fetch: noStoreFetch,
    },
  });
}

export function isServiceRoleAvailable(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
