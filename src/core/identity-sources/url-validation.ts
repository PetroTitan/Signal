/**
 * Phase F7.0 — identity source URL validation.
 *
 * Pure validation for `source_website_url` and entries in
 * `reference_urls`. Used by:
 *   - the accounts UI server action (createAccountAction +
 *     updateIdentitySourcesAction)
 *   - the MCP write tools (accountsPrepare, identitiesUpdate)
 *
 * No I/O. Deterministic for a given input.
 *
 * Rules
 * -----
 *   - must parse as a URL
 *   - scheme MUST be `https:` (operator-facing brand sources don't
 *     run on http in 2026)
 *   - hostname must NOT be localhost / 127.0.0.1 / 0.0.0.0 / ::1
 *   - hostname must NOT be a preview / staging domain operators
 *     commonly type by accident (*.vercel.app, *.netlify.app,
 *     *.preview.*, *.staging.*)
 *   - port must be empty / standard (no :3000 dev servers)
 *   - hash + query stripped before normalization (we store the
 *     canonical brand surface, not a deep link)
 */

const FORBIDDEN_HOST_EXACT: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
]);

const FORBIDDEN_HOST_SUFFIXES: ReadonlyArray<string> = [
  ".vercel.app",
  ".netlify.app",
  ".onrender.com",
  ".herokuapp.com",
  ".ngrok.io",
  ".ngrok-free.app",
  ".loca.lt",
  ".github.io.local",
];

const FORBIDDEN_HOST_CONTAINS: ReadonlyArray<string> = [
  ".preview.",
  ".staging.",
];

export type UrlValidationError =
  | "url_required"
  | "url_invalid_format"
  | "url_scheme_must_be_https"
  | "url_localhost_not_allowed"
  | "url_preview_domain_not_allowed"
  | "url_port_not_allowed";

export interface UrlValidationResult {
  ok: boolean;
  normalized: string | null;
  error: UrlValidationError | null;
  message: string | null;
}

/**
 * Validate AND normalize a single URL. Returns the canonical form
 * (lowercased host, trailing slash stripped, no query, no hash) on
 * success.
 */
export function validateIdentitySourceUrl(
  raw: string | null | undefined,
  options: { required?: boolean } = {},
): UrlValidationResult {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    if (options.required) {
      return {
        ok: false,
        normalized: null,
        error: "url_required",
        message: "Source website is required for active publishing identities.",
      };
    }
    return { ok: true, normalized: null, error: null, message: null };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      normalized: null,
      error: "url_invalid_format",
      message: `"${trimmed}" is not a valid URL.`,
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      normalized: null,
      error: "url_scheme_must_be_https",
      message: `Source URL must use https:// (got "${parsed.protocol}").`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (FORBIDDEN_HOST_EXACT.has(host)) {
    return {
      ok: false,
      normalized: null,
      error: "url_localhost_not_allowed",
      message: `"${host}" is a local address; pass the public site URL instead.`,
    };
  }
  for (const suffix of FORBIDDEN_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return {
        ok: false,
        normalized: null,
        error: "url_preview_domain_not_allowed",
        message: `"${host}" looks like a preview / staging domain. Use the production brand URL.`,
      };
    }
  }
  for (const fragment of FORBIDDEN_HOST_CONTAINS) {
    if (host.includes(fragment)) {
      return {
        ok: false,
        normalized: null,
        error: "url_preview_domain_not_allowed",
        message: `"${host}" looks like a preview / staging domain. Use the production brand URL.`,
      };
    }
  }
  if (parsed.port.length > 0) {
    return {
      ok: false,
      normalized: null,
      error: "url_port_not_allowed",
      message: `Source URL should not include a port (got ":${parsed.port}"). Use the public URL.`,
    };
  }

  // Normalize: lowercased host, drop query + hash, strip trailing
  // slash from the path. Keep deeper paths verbatim (operator may
  // intentionally point at /blog or /docs).
  const path = parsed.pathname.replace(/\/+$/, "");
  const normalized = `https://${host}${path}`;
  return { ok: true, normalized, error: null, message: null };
}

export interface ReferenceUrlsValidationResult {
  ok: boolean;
  normalized: string[];
  errors: ReadonlyArray<{ index: number; error: UrlValidationError; message: string }>;
}

/**
 * Validate + normalize a list of reference URLs.
 *
 *   - duplicates (after normalization) collapse to one
 *   - empty / whitespace-only entries are dropped
 *   - any invalid entry fails the whole list with that entry's
 *     error code
 */
export function validateIdentityReferenceUrls(
  raw: ReadonlyArray<string | null | undefined>,
): ReferenceUrlsValidationResult {
  const errors: Array<{
    index: number;
    error: UrlValidationError;
    message: string;
  }> = [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const trimmed = (entry ?? "").trim();
    if (trimmed.length === 0) continue;
    const v = validateIdentitySourceUrl(trimmed, { required: true });
    if (!v.ok || v.normalized === null) {
      errors.push({
        index: i,
        error: v.error ?? "url_invalid_format",
        message: v.message ?? "Invalid URL.",
      });
      continue;
    }
    if (seen.has(v.normalized)) continue;
    seen.add(v.normalized);
    normalized.push(v.normalized);
  }
  return {
    ok: errors.length === 0,
    normalized,
    errors,
  };
}
