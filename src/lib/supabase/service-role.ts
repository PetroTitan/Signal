import "server-only";
import { createClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "./env";

/**
 * Phase F0 — server-only service-role client.
 *
 * Scope is intentionally narrow: this client is imported **only** by
 * the MCP HTTP bridge (`src/app/api/mcp/route.ts` and the repository
 * modules under `src/repositories/mcp-server/`). It exists because
 * external operators authenticate via bearer token, not a Supabase
 * cookie session, so there is no other way to bridge from "validated
 * bearer token" to "scoped DB access".
 *
 * Discipline:
 *
 *   - Never import this from a client component or a page.
 *   - Never expose the returned client through any other repository.
 *   - Never log the key.
 *   - When SUPABASE_SERVICE_ROLE_KEY is unset, the function returns
 *     null and the MCP route returns 503 — no silent fallback.
 *
 * The audited tools layer (`src/mcp/tools/`) is the only consumer.
 * That layer enforces token-scope checks, audits every call, and
 * scopes every query to the token's workspace_id.
 */
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
        "x-signal-service-role": "mcp-http-bridge",
      },
    },
  });
}

export function isServiceRoleAvailable(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
