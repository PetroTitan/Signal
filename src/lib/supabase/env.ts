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
 * Safe-to-log report describing what the Supabase env looked like at read
 * time. Never includes the anon-key value or any URL credential.
 */
export interface SupabaseConfigDiagnostics {
  urlPresent: boolean;
  urlLength: number;
  urlParses: boolean;
  urlIsHttps: boolean;
  urlHostnameLooksLikeSupabase: boolean;
  urlHasNoPath: boolean;
  /** Parsed components for the operator to inspect. Empty when URL did not parse. */
  urlHostname: string;
  urlProtocol: string;
  /** Truncated to 80 chars to avoid leaking accidentally-pasted secrets. */
  urlPathname: string;
  urlHasSearch: boolean;
  urlHasHash: boolean;
  /** True when normalization stripped surrounding quotes or trailing slashes. */
  urlNormalizationApplied: boolean;
  anonKeyPresent: boolean;
  anonKeyLength: number;
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

const SUPABASE_HOSTNAME_SUFFIX = ".supabase.co";

// Characters that often sneak into pasted env values and corrupt URLs:
// ZWSP, ZWNJ, ZWJ, BOM, NBSP.
// We strip them, count it as normalization, and continue.
const INVISIBLE_RE = /[​‌‍﻿ ]+/g;

interface NormalizationResult {
  value: string | null;
  applied: boolean;
}

function normalizeEnvValue(name: string): NormalizationResult {
  const raw = process.env[name];
  if (raw === undefined || raw === null) {
    return { value: null, applied: false };
  }

  let working = raw;
  let applied = false;

  // 1. Strip invisible characters anywhere in the string.
  const withoutInvisible = working.replace(INVISIBLE_RE, "");
  if (withoutInvisible !== working) {
    working = withoutInvisible;
    applied = true;
  }

  // 2. Trim Unicode whitespace from both ends.
  const trimmed = working.trim();
  if (trimmed !== working) {
    working = trimmed;
    applied = true;
  }

  // 3. Strip a single layer of surrounding quotes (Vercel-paste accidents).
  if (working.length >= 2) {
    const first = working[0];
    const last = working[working.length - 1];
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      working = working.slice(1, -1).trim();
      applied = true;
    }
  }

  if (working.length === 0) {
    return { value: null, applied };
  }
  return { value: working, applied };
}

function normalizeUrl(value: string): { value: string; applied: boolean } {
  // Strip any number of trailing slashes.
  const trimmedSlash = value.replace(/\/+$/, "");
  return {
    value: trimmedSlash,
    applied: trimmedSlash !== value,
  };
}

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

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface ReadResult {
  rawUrl: string | null;
  rawAnonKey: string | null;
  urlNormalizationApplied: boolean;
  anonKeyNormalizationApplied: boolean;
}

function readVars(): ReadResult {
  const url = normalizeEnvValue("NEXT_PUBLIC_SUPABASE_URL");
  const key = normalizeEnvValue("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return {
    rawUrl: url.value,
    rawAnonKey: key.value,
    urlNormalizationApplied: url.applied,
    anonKeyNormalizationApplied: key.applied,
  };
}

function diagnose(input: ReadResult): SupabaseConfigDiagnostics {
  const { rawUrl, rawAnonKey } = input;
  const d: SupabaseConfigDiagnostics = {
    urlPresent: !!rawUrl,
    urlLength: rawUrl?.length ?? 0,
    urlParses: false,
    urlIsHttps: false,
    urlHostnameLooksLikeSupabase: false,
    urlHasNoPath: false,
    urlHostname: "",
    urlProtocol: "",
    urlPathname: "",
    urlHasSearch: false,
    urlHasHash: false,
    urlNormalizationApplied:
      input.urlNormalizationApplied || input.anonKeyNormalizationApplied,
    anonKeyPresent: !!rawAnonKey,
    anonKeyLength: rawAnonKey?.length ?? 0,
    anonKeyShape: classifyAnonKey(rawAnonKey),
    reason: null,
  };

  if (!rawUrl) {
    d.reason = "NEXT_PUBLIC_SUPABASE_URL is missing or empty.";
    return d;
  }

  // Strip trailing slashes before parsing so `https://x.supabase.co/` and
  // `https://x.supabase.co///` are both treated as base URLs. Path-bearing
  // URLs are still rejected below.
  const { value: prepared, applied: trailingStripped } = normalizeUrl(rawUrl);
  if (trailingStripped) d.urlNormalizationApplied = true;

  let parsed: URL;
  try {
    parsed = new URL(prepared);
    d.urlParses = true;
    d.urlHostname = parsed.hostname;
    d.urlProtocol = parsed.protocol;
    d.urlPathname = truncate(parsed.pathname, 80);
    d.urlHasSearch = parsed.search.length > 0;
    d.urlHasHash = parsed.hash.length > 0;
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
  if (!d.urlHasNoPath || d.urlHasSearch || d.urlHasHash) {
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
  const input = readVars();
  const d = diagnose(input);
  if (d.reason !== null) return null;
  // Final normalized url has any trailing slashes stripped.
  const url = (input.rawUrl as string).replace(/\/+$/, "");
  return { url, anonKey: input.rawAnonKey as string };
}

/**
 * Diagnostic-only view. Safe to log; never returns the anon-key value.
 */
export function diagnoseSupabaseConfig(): SupabaseConfigDiagnostics {
  return diagnose(readVars());
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

let _loggedOnce = false;

/**
 * One-time per process: log the safe diagnostics shape to the server logs.
 * Subsequent calls are no-ops. Use only from server-side entry points
 * (middleware, server actions). Never logs the anon-key value.
 */
export function logSupabaseEnvDiagnosticsOnce(source: string): void {
  if (_loggedOnce) return;
  _loggedOnce = true;
  const d = diagnoseSupabaseConfig();
  // Use console.log so it shows up in Vercel's standard log stream.
  console.log(`[supabase-env] ${source} diagnostics`, d);
}
