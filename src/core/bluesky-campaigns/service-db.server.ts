import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

const CONFIG_ERROR =
  "Automatic following is not configured on this deployment. SUPABASE_SERVICE_ROLE_KEY is required.";

/**
 * Campaign RPCs are intentionally service-role-only. Callers must
 * authenticate and authorize the user before asking for this client,
 * and every repository call must still carry an explicit workspace id.
 */
export function requireCampaignServiceDb(): SupabaseClient {
  const db = createSupabaseServiceRoleClient();
  if (!db) throw new Error(CONFIG_ERROR);
  return db;
}

export { CONFIG_ERROR as CAMPAIGN_SERVICE_DB_CONFIG_ERROR };
