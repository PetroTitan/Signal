/**
 * Lightweight scheduling-lifecycle observability.
 *
 * Zero external vendors. No Sentry/Datadog/analytics SDKs. Pure
 * structured logging — JSON-safe payloads emitted via `console.debug`
 * (dev) or `console.log` (production) with a stable `signal_event`
 * prefix that the host's log shipper can grep on.
 *
 * Edge-safe: no Node-only APIs. Tree-shake friendly: every emitter
 * is a discrete top-level export.
 *
 * Never logs:
 *  - bodies / titles / drafts (content)
 *  - tokens
 *  - workspace secrets
 *  - operator identifiers (email, name)
 * Always logs:
 *  - itemId (UUID, opaque)
 *  - source
 *  - reason
 *  - checksum (opaque hex)
 *  - timestamps (UTC ISO)
 *  - timezone (IANA name when available)
 *  - driftMs
 *  - mutationBlocked boolean
 */

export type ScheduleSource =
  | "manual"
  | "preset"
  | "mcp"
  | "api"
  | "migration"
  | "recovery";

export type ScheduleEventName =
  | "schedule_save_success"
  | "schedule_save_rejected"
  | "schedule_parse_invalid"
  | "schedule_roundtrip_delta"
  | "schedule_source_change"
  | "schedule_checksum_mismatch"
  | "rewrite_schedule_mutation_attempt"
  | "autosave_schedule_mutation_attempt";

export interface ScheduleEventPayload {
  itemId: string | null;
  source: ScheduleSource | null;
  /** Operator-visible reason (preset / input / clear / mcp). */
  reason?: string | null;
  /** UTC ISO timestamp the event was emitted at. */
  at: string;
  /** IANA timezone of the originating environment, when knowable. */
  timezone?: string | null;
  /** Drift in milliseconds between two ISO timestamps, when applicable. */
  driftMs?: number;
  /** Opaque fingerprint linking a schedule across boundaries. */
  checksum?: string | null;
  /** True when the event represents a rejected mutation. */
  mutationBlocked?: boolean;
  /** Free-form short note (no content / no secrets). */
  detail?: string;
}

/**
 * Internal sink — replaceable in tests via `__setScheduleEventSink`.
 * The default writes a single line to console.debug in dev and
 * console.log in production. Tests intercept via the sink override.
 */
type Sink = (event: ScheduleEventName, payload: ScheduleEventPayload) => void;

const defaultSink: Sink = (event, payload) => {
  const line = JSON.stringify({
    signal_event: event,
    ...payload,
  });
  // Server runtimes: prefer console.log so it lands in stdout
  // shipping pipelines. Dev / browser: console.debug for less noise.
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.log(line);
  } else {
    // eslint-disable-next-line no-console
    console.debug(line);
  }
};

let activeSink: Sink = defaultSink;

/** Test-only: install a sink that captures events synchronously. */
export function __setScheduleEventSink(sink: Sink | null): void {
  activeSink = sink ?? defaultSink;
}

function currentTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function emit(
  event: ScheduleEventName,
  partial: Omit<ScheduleEventPayload, "at" | "timezone"> & {
    at?: string;
    timezone?: string | null;
  },
): void {
  const payload: ScheduleEventPayload = {
    at: partial.at ?? nowIso(),
    timezone: partial.timezone ?? currentTimezone(),
    itemId: partial.itemId,
    source: partial.source,
    reason: partial.reason ?? null,
    driftMs: partial.driftMs,
    checksum: partial.checksum ?? null,
    mutationBlocked: partial.mutationBlocked,
    detail: partial.detail,
  };
  activeSink(event, payload);
}

// =====================================================================
// Discrete event emitters — one export per event name for
// tree-shake friendliness.
// =====================================================================

export function emitScheduleSaveSuccess(
  args: Omit<ScheduleEventPayload, "at" | "timezone" | "mutationBlocked">,
): void {
  emit("schedule_save_success", { ...args, mutationBlocked: false });
}

export function emitScheduleSaveRejected(
  args: Omit<ScheduleEventPayload, "at" | "timezone"> & { detail: string },
): void {
  emit("schedule_save_rejected", { ...args, mutationBlocked: true });
}

export function emitScheduleParseInvalid(
  args: Omit<ScheduleEventPayload, "at" | "timezone"> & { detail: string },
): void {
  emit("schedule_parse_invalid", { ...args, mutationBlocked: true });
}

export function emitScheduleRoundtripDelta(
  args: Omit<ScheduleEventPayload, "at" | "timezone"> & {
    driftMs: number;
  },
): void {
  emit("schedule_roundtrip_delta", args);
}

export function emitScheduleSourceChange(
  args: Omit<ScheduleEventPayload, "at" | "timezone"> & { detail: string },
): void {
  emit("schedule_source_change", args);
}

export function emitScheduleChecksumMismatch(
  args: Omit<ScheduleEventPayload, "at" | "timezone"> & {
    checksum: string;
    detail: string;
  },
): void {
  emit("schedule_checksum_mismatch", { ...args, mutationBlocked: true });
}

export function emitRewriteScheduleMutationAttempt(
  args: Omit<ScheduleEventPayload, "at" | "timezone">,
): void {
  emit("rewrite_schedule_mutation_attempt", {
    ...args,
    mutationBlocked: true,
  });
}

export function emitAutosaveScheduleMutationAttempt(
  args: Omit<ScheduleEventPayload, "at" | "timezone">,
): void {
  emit("autosave_schedule_mutation_attempt", {
    ...args,
    mutationBlocked: true,
  });
}
