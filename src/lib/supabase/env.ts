/**
 * Safe accessors for the two Supabase env vars Signal ships with.
 * Reads only NEXT_PUBLIC_* values so this module is safe to import from
 * both client and server boundaries. Never reads SUPABASE_SERVICE_ROLE_KEY.
 */

export interface SupabasePublicEnv {
  url: string;
  anonKey: string;
}

export class SupabaseEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseEnvError";
  }
}

function readVar(name: string): string | null {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}

/**
 * Returns the validated env or null when configuration is missing. Callers
 * that absolutely require Supabase should call `requireSupabaseEnv()`.
 */
export function readSupabaseEnv(): SupabasePublicEnv | null {
  const url = readVar("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = readVar("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  if (!/^https:\/\//.test(url)) return null;
  return { url, anonKey };
}

export function requireSupabaseEnv(): SupabasePublicEnv {
  const env = readSupabaseEnv();
  if (!env) {
    throw new SupabaseEnvError(
      "Supabase env not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local. See .env.example.",
    );
  }
  return env;
}

export function isSupabaseConfigured(): boolean {
  return readSupabaseEnv() !== null;
}
