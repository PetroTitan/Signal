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
    },
  });
}

export function isServiceRoleAvailable(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}
