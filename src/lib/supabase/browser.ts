"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseEnv } from "./env";

let cached: ReturnType<typeof createBrowserClient> | null = null;

/**
 * Browser Supabase client. Reads only the public anon key. Cached at the
 * module level so multiple calls in the same browser tab share one
 * client. Server code must use `createSupabaseServerClient` instead.
 *
 * See `server.ts` for why we do not pass a Database generic.
 */
export function getSupabaseBrowserClient() {
  if (cached) return cached;
  const env = requireSupabaseEnv();
  cached = createBrowserClient(env.url, env.anonKey);
  return cached;
}
