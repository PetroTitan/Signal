/**
 * Safe AT Protocol error-body reader.
 *
 * AT Proto XRPC endpoints return a JSON body on every non-2xx
 * response, e.g.:
 *   { "error": "InvalidRequest",
 *     "message": "Record/text must not be longer than 300 graphemes" }
 *
 * Before this module the publish-bluesky.ts error branches discarded
 * that body entirely — every failed publish surfaced as the opaque
 * "createRecord returned 400" with no actionable detail. This helper
 * reads the body safely, extracts the structured AT Proto fields,
 * truncates the raw body to a safe size, and scrubs anything that
 * looks like a Bearer token / JWT / cookie before persistence.
 *
 * Pure module — no I/O, no Supabase, no logging side effects. The
 * caller decides where the returned struct ends up
 * (publish-bluesky.ts threads it into PublishOutcome.metadata, which
 * applyOutcome persists to execution_items.metadata.publish_outcome
 * and execution_logs.metadata).
 *
 * Invariants:
 *   - never throws (every failure mode produces a structured
 *     `BlueskyErrorBody` result the caller can persist)
 *   - never returns the raw body unredacted — the truncated body
 *     always passes through the redactor first
 *   - truncation is character-based; AT Proto error bodies are small
 *     JSON (~50–300 chars), so 2000 chars is generous
 */

/** Hard cap on the persisted body string. AT Proto error bodies are
 *  small JSON in practice; the limit protects us from any future
 *  endpoint that returns an HTML page or a large stack trace. */
export const ATPROTO_ERROR_BODY_MAX_CHARS = 2000;

export interface BlueskyErrorBody {
  /** AT Proto `error` field (e.g. "InvalidRequest", "RateLimitExceeded"). null when not JSON. */
  atproto_error: string | null;
  /** AT Proto `message` field (e.g. "Record/text must not be longer than 300 graphemes"). null when not JSON. */
  atproto_message: string | null;
  /** The raw response body, redacted of token-shaped strings, truncated to ATPROTO_ERROR_BODY_MAX_CHARS. */
  atproto_response_body_truncated: string | null;
  /** True when the body was longer than ATPROTO_ERROR_BODY_MAX_CHARS and got cut. */
  atproto_response_body_was_truncated: boolean;
}

/**
 * Read the response body once, parse it as JSON if shape matches,
 * redact and truncate. Catches every error path so the caller can
 * still return a PublishOutcome.
 *
 * The Response is read via `.text()`; `.clone()` is unnecessary
 * because the caller has already decided to fail this attempt and
 * will not re-read the body.
 */
export async function readBlueskyErrorBody(
  resp: Response,
): Promise<BlueskyErrorBody> {
  let raw: string;
  try {
    raw = await resp.text();
  } catch {
    return emptyResult();
  }
  if (raw.length === 0) return emptyResult();

  // Truncate first, then redact. Truncation before redaction means
  // the post-redaction string is at most ATPROTO_ERROR_BODY_MAX_CHARS
  // (redaction only shortens or keeps length equal).
  const wasTruncated = raw.length > ATPROTO_ERROR_BODY_MAX_CHARS;
  const truncated = wasTruncated
    ? raw.slice(0, ATPROTO_ERROR_BODY_MAX_CHARS)
    : raw;
  const redactedBody = redactSensitive(truncated);

  let atprotoError: string | null = null;
  let atprotoMessage: string | null = null;
  try {
    const json = JSON.parse(raw);
    if (typeof json === "object" && json !== null) {
      const obj = json as Record<string, unknown>;
      if (typeof obj.error === "string") atprotoError = obj.error;
      if (typeof obj.message === "string") atprotoMessage = obj.message;
    }
  } catch {
    // Non-JSON body (e.g. PDS returning HTML). The redacted body is
    // still persisted; structured fields stay null.
  }

  // Redact extracted fields too — defensive, in case a future PDS
  // echoes auth context into error.message.
  return {
    atproto_error: atprotoError !== null ? redactSensitive(atprotoError) : null,
    atproto_message:
      atprotoMessage !== null ? redactSensitive(atprotoMessage) : null,
    atproto_response_body_truncated: redactedBody,
    atproto_response_body_was_truncated: wasTruncated,
  };
}

function emptyResult(): BlueskyErrorBody {
  return {
    atproto_error: null,
    atproto_message: null,
    atproto_response_body_truncated: null,
    atproto_response_body_was_truncated: false,
  };
}

/**
 * Redact patterns that look like credentials so the persisted body
 * never carries a token even if the upstream PDS or a future
 * endpoint echoed one back. The list is intentionally conservative —
 * AT Proto error bodies are normally short JSON without secrets,
 * but defense-in-depth costs nothing here.
 */
const REDACTORS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bearer / Authorization: header value
  { pattern: /Bearer\s+[A-Za-z0-9._\-+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  {
    pattern: /Authorization:\s*[A-Za-z0-9._\-+/=\s]+/gi,
    replacement: "Authorization: [REDACTED]",
  },
  // Raw JWT (three base64url segments separated by dots, leading eyJ
  // signature). Match runs of 60+ chars to avoid matching trivial
  // dotted identifiers.
  { pattern: /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g, replacement: "[REDACTED-JWT]" },
  // accessJwt / refreshJwt JSON values
  {
    pattern: /"(accessJwt|refreshJwt|access_token|refresh_token|app_password)"\s*:\s*"[^"]*"/g,
    replacement: '"$1":"[REDACTED]"',
  },
  // Cookie header value
  {
    pattern: /Cookie:\s*[^\n\r]+/gi,
    replacement: "Cookie: [REDACTED]",
  },
  // Bluesky app password shape: xxxx-xxxx-xxxx-xxxx
  {
    pattern: /\b[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b/gi,
    replacement: "[REDACTED-APP-PASSWORD]",
  },
];

export function redactSensitive(input: string): string {
  let out = input;
  for (const { pattern, replacement } of REDACTORS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Build the inner `reasonDetail` fragment from a parsed AT Proto
 * error. The publisher already wraps every failure detail with a
 * leading "Bluesky: " — this fragment must NOT repeat the prefix.
 * Falls back to the original "createRecord returned N" shape when no
 * structured fields were captured.
 *
 * Examples (the publisher wraps each with "Bluesky: " before
 * persistence, so the persisted reason_detail reads:
 *   "Bluesky: createRecord failed: InvalidRequest — …"
 */
export function formatBlueskyReasonDetail(
  endpoint: "createRecord" | "createSession" | "uploadBlob",
  httpStatus: number,
  body: BlueskyErrorBody,
): string {
  if (body.atproto_error && body.atproto_message) {
    return `${endpoint} failed: ${body.atproto_error} — ${body.atproto_message}`;
  }
  if (body.atproto_error) {
    return `${endpoint} failed: ${body.atproto_error} (HTTP ${httpStatus})`;
  }
  if (body.atproto_message) {
    return `${endpoint} failed: ${body.atproto_message} (HTTP ${httpStatus})`;
  }
  return `${endpoint} returned ${httpStatus}`;
}
