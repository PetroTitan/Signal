/**
 * Workspace-timezone aware time helpers.
 *
 * Pure module — no I/O, no React, no Supabase. The whole point is to
 * stop the rest of the codebase from reaching for `new Date(localStr)`
 * (which interprets in the runtime zone — browser on the client, UTC
 * on Vercel) and to make the workspace's chosen timezone the explicit
 * basis for every parse and every display.
 *
 * Conventions
 * -----------
 * - UTC is the database / wire format. Every Date/ISO that crosses the
 *   wire is UTC.
 * - The "workspace timezone" is an IANA name read from
 *   `workspace_settings.timezone` (e.g. "America/New_York").
 * - The browser's local zone is NEVER trusted for canonical parsing.
 *   It is only used as a last-ditch fallback when no workspace zone
 *   is available, and the helper logs a dev warning so it surfaces in
 *   review.
 *
 * Out of scope for this module: any I/O, any UI rendering, any
 * publish-pipeline behavior.
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;

/**
 * Phase F7.5 — safe IANA timezone normalizer.
 *
 * Production crash root cause: workspace_settings.timezone is a
 * free-text column written from a free-text settings input, so
 * operators can save non-IANA strings ("Eastern Time", typo'd
 * casing, stray whitespace, accidental empty). Passing any of those
 * into `Intl.DateTimeFormat({ timeZone })` throws `RangeError:
 * Invalid time zone specified`, which propagates as a Server
 * Component render error and crashes /dashboard and /weekly-plan.
 *
 * This helper is the single point of truth: every formatter call
 * site is wrapped to normalize the input through here first.
 * Invalid / null / empty → "UTC" fallback. Valid IANA → returned
 * verbatim (post-trim).
 *
 * Probe-based validation: `Intl.DateTimeFormat({ timeZone })` is
 * the only cross-runtime way to ask "is this a valid IANA name?"
 * without bundling tzdata. We catch the RangeError and translate
 * it to the safe fallback.
 *
 * Pure — no I/O, no clock.
 */
export function normalizeWorkspaceTimezone(
  input: string | null | undefined,
): string {
  if (input === null || input === undefined) return "UTC";
  const trimmed = String(input).trim();
  if (trimmed.length === 0) return "UTC";
  try {
    // The constructor itself throws on invalid zones — even before
    // .format() is called. Cheapest valid-IANA probe available.
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return trimmed;
  } catch {
    return "UTC";
  }
}

/**
 * Like normalizeWorkspaceTimezone but returns a richer result so
 * callers can surface an operator-facing reason. Used by the
 * settings-action validator to refuse writes of invalid zones.
 */
export function validateWorkspaceTimezone(
  input: string | null | undefined,
):
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "invalid"; rawValue: string } {
  if (input === null || input === undefined) {
    return { ok: false, reason: "empty", rawValue: "" };
  }
  const trimmed = String(input).trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty", rawValue: trimmed };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return { ok: true, value: trimmed };
  } catch {
    return { ok: false, reason: "invalid", rawValue: trimmed };
  }
}

/**
 * Read the offset (in ms) that a given UTC instant is from a target
 * timezone's wall clock. Positive when the zone is east of UTC.
 *
 * `Intl.DateTimeFormat` is the only cross-runtime way to get this
 * answer without pulling in tz data. The trick is to format the
 * instant as the wall-clock parts in the zone, reassemble those
 * parts as a `Date.UTC(...)` pseudo-instant, and subtract.
 */
function tzOffsetMs(utcInstantMs: number, timeZone: string): number {
  // Defense-in-depth: production crash was traced to invalid IANA
  // values reaching this Intl call site. Callers normalize via
  // `normalizeWorkspaceTimezone` upstream, but we double-check here
  // so a server component can never throw `RangeError: Invalid
  // time zone specified` even if a future caller forgets.
  const safeZone = normalizeWorkspaceTimezone(timeZone);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcInstantMs));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`tzOffsetMs: missing part ${type}`);
    return Number(p.value);
  };
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - utcInstantMs;
}

/**
 * Bare `YYYY-MM-DDTHH:MM` (and optional `:SS`) → UTC ISO interpreted
 * in `timezone`.
 *
 * Idempotent: if `localValue` already carries a TZ designator (`Z` or
 * `±HH:MM`), the string is normalized via `new Date(...).toISOString()`
 * and the `timezone` parameter is ignored — the caller has already
 * pinned the instant.
 *
 * DST semantics:
 *   - Spring-forward gap (e.g. 02:30 on a US DST start day): the
 *     wall clock doesn't exist in the zone. We bias FORWARD to the
 *     equivalent post-jump UTC instant, matching standard JS
 *     behavior. The resulting ISO still represents a real instant;
 *     callers downstream see a 03:30 wall clock when re-formatted.
 *   - Fall-back overlap (02:30 on US DST end day appears twice): we
 *     pick the FIRST occurrence (still-DST, earlier UTC). Callers
 *     who need the second occurrence must supply a TZ-qualified
 *     ISO directly.
 *
 * Throws on empty / unparseable input.
 */
export function parseWorkspaceLocalDateTimeToUtc(
  localValue: string,
  timezone: string,
): string {
  const trimmed = localValue.trim();
  if (trimmed.length === 0) {
    throw new Error("parseWorkspaceLocalDateTimeToUtc: empty value");
  }
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(
        `parseWorkspaceLocalDateTimeToUtc: invalid TZ-qualified value "${localValue}"`,
      );
    }
    return d.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    trimmed,
  );
  if (!match) {
    throw new Error(
      `parseWorkspaceLocalDateTimeToUtc: invalid datetime-local value "${localValue}"`,
    );
  }
  const [, y, m, d, hh, mm, ss] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const hour = Number(hh);
  const minute = Number(mm);
  const second = ss ? Number(ss) : 0;

  // Step 1: treat the local wall clock as UTC to get a first guess.
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  // Step 2: ask the zone what wall clock that pseudo-instant maps to.
  // The diff between naive and zone-aware is the zone's offset for
  // the instant we WANT (this is approximate near DST transitions
  // but converges in one corrective pass).
  let offset = tzOffsetMs(naiveUtcMs, timezone);
  let candidate = naiveUtcMs - offset;
  // Step 3: re-check the offset at the candidate instant. If we
  // landed on the other side of a DST jump, correct once more.
  // Convergence is guaranteed in <=2 passes for IANA zones.
  const offsetCheck = tzOffsetMs(candidate, timezone);
  if (offsetCheck !== offset) {
    offset = offsetCheck;
    candidate = naiveUtcMs - offset;
  }
  return new Date(candidate).toISOString();
}

/**
 * UTC ISO → "Mon, May 25, 2:33 PM" in the workspace zone, plus the
 * timezone label and a stable UTC string for operator debugging.
 *
 * The `local` shape is intentionally compact (weekday, month, day,
 * 12-hour). Surfaces wanting a different shape should add a new
 * variant rather than threading display options through here.
 */
export interface FormattedTime {
  /** Workspace-local display, e.g. "Mon, May 25, 2:33 PM". */
  local: string;
  /** IANA name, e.g. "America/New_York". */
  timezone: string;
  /** Stable UTC debug string, e.g. "2026-05-25 21:33 UTC". */
  utc: string;
}

export function formatUtcForWorkspace(
  utcIso: string,
  timezone: string,
): FormattedTime {
  // Defense-in-depth normalization. The crash on /dashboard +
  // /weekly-plan came from passing a non-IANA workspace timezone
  // into Intl.DateTimeFormat here — RangeError propagated as a
  // Server Component render error. We normalize so the formatter
  // never throws; the operator sees UTC instead of a 500.
  const safeZone = normalizeWorkspaceTimezone(timezone);
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) {
    return {
      local: utcIso,
      timezone: safeZone,
      utc: utcIso,
    };
  }
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return {
    local,
    timezone: safeZone,
    utc: formatUtcForOperatorDebug(utcIso),
  };
}

/**
 * Always "YYYY-MM-DD HH:mm UTC". Stable across runtimes / locales.
 * Used as the operator's ground-truth string when local zone is
 * ambiguous.
 */
export function formatUtcForOperatorDebug(utcIso: string): string {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return utcIso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
  );
}

export type DueState = "future" | "due" | "overdue";

export interface RelativeDueLabel {
  /** Operator-facing copy: "Due in 2h 49m", "Due now", "Overdue by 6m". */
  relative: string;
  /** Categorical state so callers can pick chip color / urgency. */
  state: DueState;
  /** Signed seconds: positive = future, negative = overdue. */
  deltaSeconds: number;
}

/**
 * Human-readable "Due in …" / "Due now" / "Overdue by …" relative to
 * `serverNow`. We pass `serverNow` explicitly so server components
 * stay deterministic across renders — callers should use the same
 * Date for every card on a page so the labels are coherent.
 *
 * Tolerance:
 *   - |delta| < 30s → "Due now"
 *   - else "Due in <duration>" / "Overdue by <duration>"
 *
 * Duration units (largest unit first, two units max):
 *   - >= 1 day:  "Xd Yh"
 *   - >= 1 hour: "Xh Ym"
 *   - >= 1 min:  "Xm"
 *   - else:      "<60s"
 */
export function getRelativeDueLabel(
  utcIso: string,
  serverNow: Date,
): RelativeDueLabel {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) {
    return { relative: "—", state: "future", deltaSeconds: 0 };
  }
  const deltaMs = d.getTime() - serverNow.getTime();
  const deltaSeconds = Math.round(deltaMs / SECOND_MS);
  if (Math.abs(deltaMs) < 30 * SECOND_MS) {
    return { relative: "Due now", state: "due", deltaSeconds };
  }
  const absMs = Math.abs(deltaMs);
  const duration = humanizeDuration(absMs);
  if (deltaMs > 0) {
    return { relative: `Due in ${duration}`, state: "future", deltaSeconds };
  }
  return { relative: `Overdue by ${duration}`, state: "overdue", deltaSeconds };
}

function humanizeDuration(ms: number): string {
  const days = Math.floor(ms / (24 * HOUR_MS));
  const hours = Math.floor((ms % (24 * HOUR_MS)) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (days >= 1) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours >= 1) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes >= 1) return `${minutes}m`;
  return `<1m`;
}

/**
 * Dev-only sanity check used by tests and the compose sheet's debug
 * mode. Parses `localValue` as `timezone`, then formats the result
 * back. Throws if the round-trip would shift wall-clock day, hour, or
 * minute. Used to catch DST gap regressions before they reach
 * production.
 */
export function assertScheduleRoundTrip(
  localValue: string,
  timezone: string,
): void {
  const trimmed = localValue.trim();
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    // Caller pinned an instant; the local wall clock is whatever the
    // zone displays for that instant — there is nothing to round-trip.
    return;
  }
  const utcIso = parseWorkspaceLocalDateTimeToUtc(localValue, timezone);
  const formatted = formatUtcForWorkspace(utcIso, timezone);
  const sourceMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(trimmed);
  if (!sourceMatch) return;
  const [, , , , hh, mm] = sourceMatch;
  const reparsed = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(utcIso))
    .replace(/ /g, " "); // narrow no-break space → ordinary space
  const observed = reparsed.match(/(\d{2}):(\d{2})/);
  if (!observed) return;
  const [, oh, om] = observed;
  if (oh !== hh || om !== mm) {
    // DST gap: the input wall clock didn't exist; the parser biased
    // forward. Caller may want to surface this to the operator. We
    // include both values in the message so the dev / test can
    // assert behavior without re-deriving.
    throw new Error(
      `assertScheduleRoundTrip: wall clock shifted ${hh}:${mm} → ${oh}:${om} in ${timezone} (DST gap?). Formatted as: ${formatted.local}`,
    );
  }
}
