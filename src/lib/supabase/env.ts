/**
 * Safe accessors for the two Supabase env vars Signal ships with.
 * Reads only NEXT_PUBLIC_* values so this module is safe to import from
 * both client and server boundaries. Never reads SUPABASE_SERVICE_ROLE_KEY.
 */

export interface SupabasePublicEnv {
  /** Normalized URL with no trailing slash. */
  url: string;
  anonKey: string;
}

/**
 * Diagnostic-only report. Never includes the anon-key value. Safe to log
 * and safe to render to a user.
 */
export interface SupabaseConfigDiagnostics {
  urlPresent: boolean;
  urlParses: boolean;
  urlIsHttps: boolean;
  urlHostnameLooksLikeSupabase: boolean;
  urlHasNoPath: boolean;
  anonKeyPresent: boolean;
  anonKeyShape:
    | "looks_like_jwt"
    | "looks_like_publishable"
    | "looks_like_url"
    | "unknown"
    | "missing";
  /** One-line human-readable explanation of the first failing check. */
  reason: string | null;
}

export class SupabaseEnvError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: SupabaseConfigDiagnostics,
  ) {
    super(message);
    this.name = "SupabaseEnvError";
  }
}

function readVar(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed;
}

const SUPABASE_HOSTNAME_SUFFIX = ".supabase.co";

function classifyAnonKey(
  raw: string | null,
): SupabaseConfigDiagnostics["anonKeyShape"] {
  if (!raw) return "missing";
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return "looks_like_url";
  }
  if (raw.startsWith("sb_publishable_") || raw.startsWith("sb_secret_")) {
    return "looks_like_publishable";
  }
  // Legacy Supabase anon JWT keys are header.payload.signature.
  if (raw.split(".").length === 3 && raw.startsWith("eyJ")) return "looks_like_jwt";
  return "unknown";
}

function diagnose(
  rawUrl: string | null,
  rawAnonKey: string | null,
): SupabaseConfigDiagnostics {
  const d: SupabaseConfigDiagnostics = {
    urlPresent: !!rawUrl,
    urlParses: false,
    urlIsHttps: false,
    urlHostnameLooksLikeSupabase: false,
    urlHasNoPath: false,
    anonKeyPresent: !!rawAnonKey,
    anonKeyShape: classifyAnonKey(rawAnonKey),
    reason: null,
  };

  if (!rawUrl) {
    d.reason = "NEXT_PUBLIC_SUPABASE_URL is missing or empty.";
    return d;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
    d.urlParses = true;
  } catch {
    d.reason =
      'NEXT_PUBLIC_SUPABASE_URL does not parse as a URL. Expected "https://<project-ref>.supabase.co".';
    return d;
  }

  d.urlIsHttps = parsed.protocol === "https:";
  if (!d.urlIsHttps) {
    d.reason = `NEXT_PUBLIC_SUPABASE_URL must use https:// (got "${parsed.protocol}").`;
    return d;
  }

  d.urlHostnameLooksLikeSupabase = parsed.hostname.endsWith(
    SUPABASE_HOSTNAME_SUFFIX,
  );
  if (!d.urlHostnameLooksLikeSupabase) {
    d.reason = `NEXT_PUBLIC_SUPABASE_URL hostname must end with ${SUPABASE_HOSTNAME_SUFFIX}. Got "${parsed.hostname}".`;
    return d;
  }

  d.urlHasNoPath = parsed.pathname === "" || parsed.pathname === "/";
  if (!d.urlHasNoPath || parsed.search || parsed.hash) {
    d.reason =
      "NEXT_PUBLIC_SUPABASE_URL must be the project base URL with no path, query, or fragment.";
    return d;
  }

  if (!d.anonKeyPresent) {
    d.reason = "NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty.";
    return d;
  }

  if (d.anonKeyShape === "looks_like_url") {
    d.reason =
      "NEXT_PUBLIC_SUPABASE_ANON_KEY looks like a URL. Did you swap the URL and the anon key?";
    return d;
  }

  if (d.anonKeyShape === "unknown") {
    d.reason =
      "NEXT_PUBLIC_SUPABASE_ANON_KEY shape is unrecognized. Expected a JWT (starts with eyJ) or a publishable key (sb_publishable_…).";
    return d;
  }

  return d;
}

/**
 * Returns the validated env or null when configuration is invalid. Use
 * `diagnoseSupabaseConfig()` for the diagnostic explanation.
 */
export function readSupabaseEnv(): SupabasePublicEnv | null {
  const rawUrl = readVar("NEXT_PUBLIC_SUPABASE_URL");
  const rawAnonKey = readVar("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const d = diagnose(rawUrl, rawAnonKey);
  if (d.reason !== null) return null;
  // Strip trailing slash for a consistent base URL.
  const url = (rawUrl as string).replace(/\/+$/, "");
  return { url, anonKey: rawAnonKey as string };
}

/**
 * Diagnostic-only view. Safe to log; never returns the anon-key value.
 */
export function diagnoseSupabaseConfig(): SupabaseConfigDiagnostics {
  const rawUrl = readVar("NEXT_PUBLIC_SUPABASE_URL");
  const rawAnonKey = readVar("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return diagnose(rawUrl, rawAnonKey);
}

export function requireSupabaseEnv(): SupabasePublicEnv {
  const env = readSupabaseEnv();
  if (!env) {
    const d = diagnoseSupabaseConfig();
    throw new SupabaseEnvError(d.reason ?? "Supabase env not configured.", d);
  }
  return env;
}

export function isSupabaseConfigured(): boolean {
  return readSupabaseEnv() !== null;
}
