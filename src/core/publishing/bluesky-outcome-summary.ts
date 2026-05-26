/**
 * Operator-facing summary of a Bluesky publish attempt.
 *
 * Pure module — given the persisted DB rows
 * (`execution_items.metadata.publish_outcome` + the latest
 * `execution_logs` row for the same item) plus the plan_item's
 * creatives (so we can compute divergence), produce a single typed
 * object the UI can render.
 *
 * Why pure
 * --------
 * The UI component (`<BlueskyOutcomeDiagnostics>`) is dumb — it
 * formats labels and tags from this summary. All semantic decisions
 * (which fields are present, which source produced them, whether
 * preview / publish diverged) happen here, in a module that can be
 * unit-tested without React.
 *
 * Source-of-truth labels
 * ----------------------
 * Every field carries a `source` token so the rendered UI can mark
 * provenance:
 *
 *   - "execution_item"            ← execution_items.metadata.publish_outcome
 *   - "execution_log"             ← execution_logs.metadata
 *   - "preview_rederivation"      ← re-running the deterministic
 *                                   adapter on the current body (no
 *                                   DB persistence yet for
 *                                   transformationNotes)
 *   - "absent"                    ← field is missing from every
 *                                   source
 *
 * NEVER touched / NEVER stored:
 *   - access tokens, refresh tokens, app passwords, Authorization
 *     headers. The atproto_response_body_truncated is already
 *     redacted by `readBlueskyErrorBody` upstream (PR fix/bluesky-
 *     capture-atproto-error-body), but we re-apply
 *     `redactSensitive` defensively at render time too — see the
 *     React component.
 */

import { redactSensitive } from "./atproto-error-body";
import { adaptCopyForBluesky } from "./bluesky-copy-adapter";
import { resolvePublishCreative } from "./resolve-publish-creative";
import type { WeeklyPlanItemCreative } from "@/repositories/weekly-plan-creative-repository";

// ---------------------------------------------------------------------
// Inputs (subset of the DB row shapes)
// ---------------------------------------------------------------------

/** Subset of execution_items.metadata fields we read. */
export interface BlueskyOutcomeExecutionItemInput {
  status: string;
  metadata: Record<string, unknown> | null;
  /** Plan-item body — used to re-derive transformation notes. */
  body: string | null;
  /** Plan-item title — used for transformation notes (title ignored). */
  title: string | null;
}

/** Subset of the latest execution_logs row we read. */
export interface BlueskyOutcomeExecutionLogInput {
  eventType: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface BlueskyOutcomeInput {
  /** Loaded execution_items row, with metadata.publish_outcome. */
  executionItem: BlueskyOutcomeExecutionItemInput;
  /** Most recent `item.completed` / `item.failed` / `item.blocked`
   *  log row. `null` when no terminal log row exists yet. */
  latestTerminalLog: BlueskyOutcomeExecutionLogInput | null;
  /** Plan-item creatives. Used to (a) re-derive the preview's
   *  expected creative attachment, and (b) detect divergence
   *  between approved creative and observed media_attached. */
  planItemCreatives: ReadonlyArray<WeeklyPlanItemCreative>;
}

// ---------------------------------------------------------------------
// Output shape — what the UI renders
// ---------------------------------------------------------------------

export type FieldSource =
  | "execution_item"
  | "execution_log"
  | "preview_rederivation"
  | "absent";

export interface FieldWithSource<T> {
  value: T;
  source: FieldSource;
}

export type OutcomeStatus =
  | "published"
  | "failed"
  | "blocked"
  | "scheduled"
  | "skipped"
  | "in_flight"
  | "unknown";

export type MediaAttached = "yes" | "no" | "unknown";

export interface BlueskyOutcomeSummary {
  /** Overall outcome status — published / failed / blocked / etc. */
  status: FieldWithSource<OutcomeStatus>;
  /** Reason code from publish_outcome.reason_code. */
  reasonCode: FieldWithSource<string | null>;
  /** Reason detail string. */
  reasonDetail: FieldWithSource<string | null>;
  /** External URL (bsky.app permalink) when the publish succeeded. */
  externalUrl: FieldWithSource<string | null>;
  /** Was an image actually attached on the wire? */
  mediaAttached: FieldWithSource<MediaAttached>;
  /** Thread shape on the wire. */
  threadLength: FieldWithSource<number | null>;
  /** Thread part that failed (for create-record failures). */
  threadPositionFailed: FieldWithSource<number | null>;
  /** AT Proto endpoint that produced the failure. */
  endpoint: FieldWithSource<string | null>;
  /** HTTP status from the AT Proto response. */
  httpStatus: FieldWithSource<number | null>;
  /** Structured AT Proto error (e.g. "InvalidRequest"). */
  atprotoError: FieldWithSource<string | null>;
  /** Free-text AT Proto message (e.g. "Record/text must not be …"). */
  atprotoMessage: FieldWithSource<string | null>;
  /** Truncated + redacted AT Proto response body. Re-redacted here
   *  defensively before rendering. */
  atprotoResponseBody: FieldWithSource<string | null>;
  /** The DID the publish ran under. */
  did: FieldWithSource<string | null>;
  /** Root post at-uri (for threaded publishes). */
  rootUri: FieldWithSource<string | null>;
  /** Creative row id involved (for blocked / media_upload_failed
   *  outcomes). */
  creativeId: FieldWithSource<string | null>;
  /** Deterministic transformation notes re-derived from the current
   *  body. NOT persisted — recomputed at render time. */
  transformationNotes: FieldWithSource<string[]>;
  /** Divergence flag + explanation when set. */
  divergence: BlueskyOutcomeDivergence | null;
}

export interface BlueskyOutcomeDivergence {
  kind: "expected_media_missing" | "media_status_not_recorded";
  message: string;
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function get(
  obj: Record<string, unknown> | null | undefined,
  key: string,
): unknown {
  if (!obj) return undefined;
  return obj[key];
}

function readString(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = get(obj, key);
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(obj: Record<string, unknown> | null | undefined, key: string): number | null {
  const v = get(obj, key);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function withSource<T>(
  value: T,
  source: FieldSource,
): FieldWithSource<T> {
  return { value, source };
}

function absent<T>(empty: T): FieldWithSource<T> {
  return { value: empty, source: "absent" };
}

/**
 * Walk the two persisted bags in priority order:
 *   1. execution_logs.metadata (richer — has the AT Proto fields)
 *   2. execution_items.metadata.publish_outcome (status fields)
 *
 * Returns the first hit, tagged with provenance.
 */
function readPrioritized<T>(
  key: string,
  read: (bag: Record<string, unknown> | null) => T | null,
  log: Record<string, unknown> | null,
  publishOutcome: Record<string, unknown> | null,
): FieldWithSource<T | null> {
  void key; // useful for debug logging if ever needed
  const fromLog = read(log);
  if (fromLog !== null) return withSource(fromLog, "execution_log");
  const fromExec = read(publishOutcome);
  if (fromExec !== null) return withSource(fromExec, "execution_item");
  return absent<T | null>(null);
}

function outcomeStatusFromExecution(itemStatus: string): OutcomeStatus {
  switch (itemStatus) {
    case "completed":
      return "published";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "scheduled":
      return "scheduled";
    case "skipped":
      return "skipped";
    case "running":
    case "ready":
    case "ready_for_manual_publish":
    case "authorized":
    case "pending_authorization":
      return "in_flight";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------

export function buildBlueskyOutcomeSummary(
  input: BlueskyOutcomeInput,
): BlueskyOutcomeSummary {
  const { executionItem, latestTerminalLog, planItemCreatives } = input;

  const publishOutcome =
    (executionItem.metadata?.publish_outcome as
      | Record<string, unknown>
      | undefined) ?? null;
  const logMeta = latestTerminalLog?.metadata ?? null;

  const status: FieldWithSource<OutcomeStatus> = withSource(
    outcomeStatusFromExecution(executionItem.status),
    "execution_item",
  );

  const reasonCode = readPrioritized<string>(
    "reason_code",
    (b) => readString(b, "reason_code"),
    logMeta,
    publishOutcome,
  );
  const reasonDetail = readPrioritized<string>(
    "reason_detail",
    (b) => readString(b, "reason_detail"),
    logMeta,
    publishOutcome,
  );
  const externalUrl = readPrioritized<string>(
    "external_url",
    (b) => readString(b, "external_url"),
    logMeta,
    publishOutcome,
  );

  // Media attached — log-only field. "yes" / "no" / "unknown".
  let mediaAttached: FieldWithSource<MediaAttached>;
  const mediaFromLog = get(logMeta, "media_attached");
  if (mediaFromLog === true) {
    mediaAttached = withSource("yes", "execution_log");
  } else if (mediaFromLog === false) {
    mediaAttached = withSource("no", "execution_log");
  } else {
    mediaAttached = absent<MediaAttached>("unknown");
  }

  const threadLength = readPrioritized<number>(
    "thread_length",
    (b) => readNumber(b, "thread_length"),
    logMeta,
    null,
  );
  const threadPositionFailed = readPrioritized<number>(
    "thread_position_failed",
    (b) => readNumber(b, "thread_position_failed"),
    logMeta,
    null,
  );
  const endpoint = readPrioritized<string>(
    "endpoint",
    (b) => readString(b, "endpoint"),
    logMeta,
    null,
  );
  const httpStatus = readPrioritized<number>(
    "http_status",
    (b) => readNumber(b, "http_status"),
    logMeta,
    null,
  );
  const atprotoError = readPrioritized<string>(
    "atproto_error",
    (b) => readString(b, "atproto_error"),
    logMeta,
    null,
  );
  const atprotoMessage = readPrioritized<string>(
    "atproto_message",
    (b) => readString(b, "atproto_message"),
    logMeta,
    null,
  );
  const atprotoBodyRaw = readPrioritized<string>(
    "atproto_response_body_truncated",
    (b) => readString(b, "atproto_response_body_truncated"),
    logMeta,
    null,
  );
  // Defensive re-redaction — upstream `readBlueskyErrorBody` already
  // redacted, but UI render is a second line of defense in case a
  // future log field carries unsanitized text.
  const atprotoResponseBody: FieldWithSource<string | null> = {
    value:
      atprotoBodyRaw.value !== null
        ? redactSensitive(atprotoBodyRaw.value)
        : null,
    source: atprotoBodyRaw.source,
  };
  const did = readPrioritized<string>(
    "did",
    (b) => readString(b, "did"),
    logMeta,
    null,
  );
  const rootUri = readPrioritized<string>(
    "root_uri",
    (b) => readString(b, "root_uri"),
    logMeta,
    null,
  );
  const creativeId = readPrioritized<string>(
    "creative_id",
    (b) => readString(b, "creative_id"),
    logMeta,
    publishOutcome,
  );

  // Transformation notes — re-derived from the current body. NOT
  // persisted. The adapter is pure + deterministic, so this matches
  // what the preview shows.
  const adapted = adaptCopyForBluesky({ body: executionItem.body ?? "" });
  const transformationNotes: FieldWithSource<string[]> = {
    value: adapted.transformationNotes,
    source:
      adapted.transformationNotes.length > 0
        ? "preview_rederivation"
        : "absent",
  };

  // Divergence detection: an approved creative was attached to the
  // plan_item, the publish succeeded, but the execution_log shows no
  // media. The operator's intent (image attached) did not match the
  // wire result.
  let divergence: BlueskyOutcomeDivergence | null = null;
  const creativeDecision = resolvePublishCreative(planItemCreatives);
  const expectedMedia = creativeDecision.kind === "ready";
  if (status.value === "published") {
    if (expectedMedia && mediaAttached.value === "no") {
      divergence = {
        kind: "expected_media_missing",
        message:
          "Approved creative did not attach. The plan item has an approved image, but the execution log records media_attached=false.",
      };
    } else if (expectedMedia && mediaAttached.source === "absent") {
      divergence = {
        kind: "media_status_not_recorded",
        message:
          "Media status not recorded for this publish. Cannot confirm whether the image attached.",
      };
    }
  }

  return {
    status,
    reasonCode,
    reasonDetail,
    externalUrl,
    mediaAttached,
    threadLength,
    threadPositionFailed,
    endpoint,
    httpStatus,
    atprotoError,
    atprotoMessage,
    atprotoResponseBody,
    did,
    rootUri,
    creativeId,
    transformationNotes,
    divergence,
  };
}
