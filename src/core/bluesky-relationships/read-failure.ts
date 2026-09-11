/**
 * Classifying a failed read of the relationship tables.
 *
 * Pure, client-safe. The UI renders a different surface per kind, so the
 * classification has to be shared and testable rather than a series of
 * string checks scattered through the loader.
 *
 * WHY CLASSIFY AT ALL
 * -------------------
 * Three failures look identical to a page component and must not be
 * treated identically:
 *
 *   temporary      a timeout, a dropped connection, a brief upstream
 *                  error. Retrying is reasonable, so the page offers it
 *                  and keeps everything that did load.
 *
 *   schema_missing the relationship tables do not exist — the migration
 *                  has not been applied. Retrying will never help. The
 *                  page must SAY SO, by name, because the fix is an
 *                  operator action in a completely different place.
 *
 *   authorization  RLS or a grant refused the read. Also not retryable,
 *                  and also something the operator has to act on.
 *
 * WHAT THIS MUST NOT DO
 * ---------------------
 * Turn the last two into the first. A "something went wrong, try again"
 * panel over an unapplied migration is worse than a crash: it looks
 * survivable, invites an operator to retry forever, and hides the one
 * fact that would let them fix it. The default is therefore NOT
 * `temporary` — an unrecognised error is treated as structural, because
 * wrongly offering a retry is the more expensive mistake.
 */

export type ReadFailureKind = "temporary" | "schema_missing" | "authorization";

export interface ReadFailure {
  kind: ReadFailureKind;
  /** Operator-facing. Names the cause and what to do about it. */
  message: string;
  /** Whether a Retry control should be offered. */
  retryable: boolean;
}

/** Postgres: relation does not exist. The unapplied-migration signal. */
const UNDEFINED_TABLE = "42P01";
/** Postgres: insufficient privilege. */
const INSUFFICIENT_PRIVILEGE = "42501";
/** PostgREST: schema cache has no such table — same cause, different layer. */
const PGRST_NO_TABLE = "PGRST205";

/**
 * Every `code` on the error and its cause chain.
 *
 * A list, not the first one found: `RepositoryError` carries its OWN
 * `code` ("unknown", "constraint", …) which shadows the Postgres code
 * it kept as `cause`. Returning the first match classified a genuine
 * 42P01 as unrecognised — the test for the wrapped shape caught it.
 */
function readCodes(error: unknown): string[] {
  const codes: string[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < 5 && node !== null && node !== undefined; depth += 1) {
    if (typeof node !== "object") break;
    const withCode = node as { code?: unknown; cause?: unknown };
    if (typeof withCode.code === "string") codes.push(withCode.code);
    node = withCode.cause;
  }
  return codes;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

export function classifyReadFailure(error: unknown): ReadFailure {
  const codes = readCodes(error);
  const has = (code: string) => codes.includes(code);
  const message = readMessage(error).toLowerCase();

  if (
    has(UNDEFINED_TABLE) ||
    has(PGRST_NO_TABLE) ||
    message.includes("does not exist") ||
    message.includes("could not find the table") ||
    message.includes("schema cache")
  ) {
    return {
      kind: "schema_missing",
      message:
        "The Bluesky relationship tables are not present in this database. The migration that creates them has not been applied. Retrying will not help — an administrator needs to apply it before this page can work.",
      retryable: false,
    };
  }

  if (
    has(INSUFFICIENT_PRIVILEGE) ||
    message.includes("permission denied") ||
    message.includes("row-level security") ||
    message.includes("violates row-level security policy") ||
    message.includes("jwt") ||
    message.includes("not authenticated")
  ) {
    return {
      kind: "authorization",
      message:
        "The database refused to read this workspace's relationship data. This is a permissions problem, not a temporary one — sign out and back in, and if it persists ask an administrator to check the workspace's access policies.",
      retryable: false,
    };
  }

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("socket") ||
    message.includes("temporarily unavailable") ||
    message.includes("too many connections")
  ) {
    return {
      kind: "temporary",
      message:
        "Could not reach the database just now. Nothing was changed. Try again in a moment.",
      retryable: true,
    };
  }

  // Unrecognised. Deliberately NOT treated as temporary: offering a
  // retry for something a retry cannot fix is the more expensive
  // mistake, and it is the one that hides an unapplied migration.
  return {
    kind: "authorization",
    message: `This page could not read its data, and the reason was not one Signal recognises as temporary. Retrying is unlikely to help. Details: ${
      readMessage(error) || "no message"
    }`,
    retryable: false,
  };
}
