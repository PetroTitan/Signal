import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireSupabaseEnv } from "./env";

/**
 * Server Supabase client bound to the current request's cookies. Use from
 * server components, route handlers, and server actions. Never imports
 * the service role key.
 *
 * Note: We deliberately do not pass a `Database` generic here. The
 * supabase-js `GenericSchema` extension chain requires interfaces to
 * extend `Record<string, unknown>`, which clashes with our explicit
 * domain interfaces. Repositories cast Supabase responses to the
 * typed row shapes from `./types` instead — runtime safety comes from
 * Postgres + RLS, and the repository boundary preserves the static
 * domain shape for everything above it.
 */
export function createSupabaseServerClient() {
  const env = requireSupabaseEnv();
  const cookieStore = cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `cookies().set` throws in server components that are read-only.
          // In those cases the auth state will be refreshed by the middleware
          // on the next request, so this is safe to swallow.
        }
      },
    },
  });
}
