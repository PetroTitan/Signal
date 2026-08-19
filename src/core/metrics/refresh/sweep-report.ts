/**
 * Sweep observability — the structured record of one metrics refresh run.
 *
 * Why this exists
 * ---------------
 * `post_metrics` held ZERO rows in production for two months while the
 * refresh route was deployed, the Vercel cron was configured, and the
 * cron secret was set. Nothing in the system could say why. The engine
 * caught loader failures and returned `[]`, so a hard failure and "there
 * was genuinely nothing to do" produced byte-identical output: a summary
 * reporting `scanned: 0`.
 *
 * The contract now is: after any run, an operator can answer every one of
 * these from a single record, without adding logging or redeploying —
 *
 *   did the sweep start?              → `phase`, `startedAt`
 *   which workspaces were considered? → `byWorkspace`
 *   how many candidates were found?   → `candidates`, `loaders.*.count`
 *   how many were enrolled?           → `enrolled`
 *   how many reads were attempted?    → `attempted`
 *   how many succeeded?               → `succeeded`
 *   how many were skipped?            → `skipped` + `skips`
 *   how many were rate-limited?       → `rateLimited`
 *   how many failed?                  → `failed`
 *   which provider failed?            → `byPlatform`, `failures[].platform`
 *   did the run finish?               → `phase === "completed"`
 *
 * …plus `diagnosis`, a deterministic sentence that explains a zero-row
 * outcome in operator language rather than making them infer it.
 *
 * Pure module — no I/O, no clock, no randomness. Everything is derived
 * from values passed in, so the whole thing is unit-testable and the
 * engine stays the only place that touches the world.
 *
 * SECURITY: every free-text field passes through `redactSecrets` before
 * it lands in the report. Provider errors can echo request context, and
 * this record is persisted to `activity_events` and returned as JSON by
 * an authenticated route.
 */

export type SweepPhase = "started" | "completed" | "failed";

/** Why a candidate was never handed to a provider reader. */
export type SkipReason =
  | "no_provider_identifier"
  | "platform_not_verified"
  | "duplicate_candidate";

/** How one provider read resolved. */
export type ReadOutcome =
  | "connected"
  | "unavailable"
  | "unsupported"
  | "rate_limited"
  | "failed";

export interface SweepLoaderStatus {
  /** False when the loader threw — the case that used to look like "nothing to do". */
  ok: boolean;
  count: number;
  error: string | null;
}

export interface SweepPlatformTally {
  attempted: number;
  connected: number;
  unavailable: number;
  unsupported: number;
  rateLimited: number;
  failed: number;
  skipped: number;
}

export interface SweepWorkspaceTally {
  candidates: number;
  attempted: number;
  connected: number;
  failed: number;
}

export interface SweepFailure {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  outcome: Extract<ReadOutcome, "rate_limited" | "failed" | "unavailable">;
  reason: string;
}

export interface SweepSkip {
  workspaceId: string;
  publishHistoryId: string;
  platform: string;
  reason: SkipReason;
}

export interface SweepReport {
  /** Bumped when the shape changes, so persisted rows stay interpretable. */
  version: 1;
  runId: string;
  phase: SweepPhase;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;

  /** The enrolment lookback actually in force — the value that silently
   *  orphaned every publication older than it. */
  seedWindowDays: number;
  staleLimit: number;
  seedLimit: number;
  /** Platforms the capability model considers readable this run. */
  verifiedPlatforms: string[];

  loaders: {
    stale: SweepLoaderStatus;
    unmeasured: SweepLoaderStatus;
  };

  candidates: number;
  enrolled: number;
  attempted: number;
  succeeded: number;
  unavailable: number;
  unsupported: number;
  rateLimited: number;
  failed: number;
  skipped: number;

  byPlatform: Record<string, SweepPlatformTally>;
  byWorkspace: Record<string, SweepWorkspaceTally>;
  failures: SweepFailure[];
  skips: SweepSkip[];

  /** Set when the run threw before completing. */
  fatalError: string | null;

  /** Deterministic operator-facing explanation. Never speculative. */
  diagnosis: string;
}

// ---------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers echoed into an error string.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  // Signal's own operator tokens.
  [/\bsigt_[A-Za-z0-9._~+/=-]+/g, "sigt_[redacted]"],
  // JWTs (Supabase keys, X tokens) — three base64url segments.
  [/\beyJ[A-Za-z0-9._~+/=-]{10,}/g, "[redacted-jwt]"],
  // Common query-string credential carriers.
  [
    /\b(access_token|refresh_token|client_secret|api_key|apikey|token|password|code_verifier)=[^&\s"']+/gi,
    "$1=[redacted]",
  ],
];

/**
 * Strip anything credential-shaped from free text before it is persisted
 * or returned. Deliberately conservative: it is better to redact a
 * harmless string than to leak a token into `activity_events`.
 */
export function redactSecrets(value: unknown): string {
  let text =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value == null
          ? ""
          : String(value);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  // Bound the field: provider errors can carry an entire HTML error page.
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

// ---------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------

export function emptyPlatformTally(): SweepPlatformTally {
  return {
    attempted: 0,
    connected: 0,
    unavailable: 0,
    unsupported: 0,
    rateLimited: 0,
    failed: 0,
    skipped: 0,
  };
}

export function emptyWorkspaceTally(): SweepWorkspaceTally {
  return { candidates: 0, attempted: 0, connected: 0, failed: 0 };
}

export interface SweepReportInit {
  runId: string;
  startedAt: string;
  seedWindowDays: number;
  staleLimit: number;
  seedLimit: number;
  verifiedPlatforms: string[];
}

/**
 * Accumulates one run. The engine calls the record* methods as it goes,
 * then `complete()` or `fail()`. Keeping this separate from the engine
 * means the counting logic is testable without any fake I/O.
 */
export class SweepReportBuilder {
  private readonly report: SweepReport;

  constructor(init: SweepReportInit) {
    this.report = {
      version: 1,
      runId: init.runId,
      phase: "started",
      startedAt: init.startedAt,
      finishedAt: null,
      durationMs: null,
      seedWindowDays: init.seedWindowDays,
      staleLimit: init.staleLimit,
      seedLimit: init.seedLimit,
      verifiedPlatforms: [...init.verifiedPlatforms].sort(),
      loaders: {
        stale: { ok: true, count: 0, error: null },
        unmeasured: { ok: true, count: 0, error: null },
      },
      candidates: 0,
      enrolled: 0,
      attempted: 0,
      succeeded: 0,
      unavailable: 0,
      unsupported: 0,
      rateLimited: 0,
      failed: 0,
      skipped: 0,
      byPlatform: {},
      byWorkspace: {},
      failures: [],
      skips: [],
      fatalError: null,
      diagnosis: "Sweep started but never completed.",
    };
  }

  recordLoader(
    which: "stale" | "unmeasured",
    outcome: { ok: true; count: number } | { ok: false; error: unknown },
  ): void {
    this.report.loaders[which] = outcome.ok
      ? { ok: true, count: outcome.count, error: null }
      : { ok: false, count: 0, error: redactSecrets(outcome.error) };
  }

  /** Candidates after dedupe — the set the engine will act on. */
  recordCandidates(targets: Array<{ workspaceId: string; platform: string }>): void {
    this.report.candidates = targets.length;
    for (const t of targets) {
      const ws = (this.report.byWorkspace[t.workspaceId] ??= emptyWorkspaceTally());
      ws.candidates += 1;
      this.report.byPlatform[t.platform] ??= emptyPlatformTally();
    }
  }

  recordSkip(skip: SweepSkip): void {
    this.report.skipped += 1;
    const p = (this.report.byPlatform[skip.platform] ??= emptyPlatformTally());
    p.skipped += 1;
    // Bounded: a systemic skip must not write thousands of rows.
    if (this.report.skips.length < 50) this.report.skips.push(skip);
  }

  recordRead(input: {
    workspaceId: string;
    publishHistoryId: string;
    platform: string;
    outcome: ReadOutcome;
    reason?: unknown;
  }): void {
    const p = (this.report.byPlatform[input.platform] ??= emptyPlatformTally());
    const ws = (this.report.byWorkspace[input.workspaceId] ??= emptyWorkspaceTally());
    this.report.attempted += 1;
    p.attempted += 1;
    ws.attempted += 1;

    switch (input.outcome) {
      case "connected":
        this.report.succeeded += 1;
        this.report.enrolled += 1;
        p.connected += 1;
        ws.connected += 1;
        return;
      case "unsupported":
        this.report.unsupported += 1;
        p.unsupported += 1;
        return;
      case "unavailable":
        this.report.unavailable += 1;
        p.unavailable += 1;
        break;
      case "rate_limited":
        this.report.rateLimited += 1;
        p.rateLimited += 1;
        break;
      case "failed":
        this.report.failed += 1;
        p.failed += 1;
        ws.failed += 1;
        break;
    }

    if (this.report.failures.length < 50) {
      this.report.failures.push({
        workspaceId: input.workspaceId,
        publishHistoryId: input.publishHistoryId,
        platform: input.platform,
        outcome: input.outcome as SweepFailure["outcome"],
        reason: redactSecrets(input.reason ?? input.outcome),
      });
    }
  }

  complete(finishedAt: string): SweepReport {
    this.report.phase = "completed";
    this.report.finishedAt = finishedAt;
    this.report.durationMs = durationMs(this.report.startedAt, finishedAt);
    this.report.diagnosis = diagnose(this.report);
    return this.snapshot();
  }

  fail(finishedAt: string, error: unknown): SweepReport {
    this.report.phase = "failed";
    this.report.finishedAt = finishedAt;
    this.report.durationMs = durationMs(this.report.startedAt, finishedAt);
    this.report.fatalError = redactSecrets(error);
    this.report.diagnosis = `Sweep threw before completing: ${this.report.fatalError}`;
    return this.snapshot();
  }

  snapshot(): SweepReport {
    return JSON.parse(JSON.stringify(this.report)) as SweepReport;
  }
}

function durationMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

// ---------------------------------------------------------------------
// diagnosis
// ---------------------------------------------------------------------

/**
 * A deterministic sentence explaining the run's outcome, ordered so the
 * FIRST true cause wins — an operator reading a zero-row run should not
 * have to rank six possible explanations themselves.
 *
 * Every branch describes only what the report actually observed. No
 * branch speculates about cron scheduling or environment variables,
 * because a run that produced a report necessarily got that far.
 */
export function diagnose(r: SweepReport): string {
  const bothLoadersFailed = !r.loaders.stale.ok && !r.loaders.unmeasured.ok;
  const someLoaderFailed = !r.loaders.stale.ok || !r.loaders.unmeasured.ok;

  if (bothLoadersFailed) {
    return (
      "No posts were considered: BOTH candidate loaders failed, so the sweep " +
      `had nothing to act on. Stale loader: ${r.loaders.stale.error}. ` +
      `Unmeasured loader: ${r.loaders.unmeasured.error}. ` +
      "This is a database or permissions problem, not an empty backlog."
    );
  }

  if (r.candidates === 0) {
    const failedPart = someLoaderFailed
      ? ` One loader also failed (${r.loaders.stale.ok ? r.loaders.unmeasured.error : r.loaders.stale.error}), so this count may be incomplete.`
      : "";
    return (
      "No candidates found. " +
      `${r.loaders.stale.count} row(s) were due for refresh and ` +
      `${r.loaders.unmeasured.count} unmeasured publication(s) fell inside the ` +
      `${r.seedWindowDays}-day enrolment window on platforms ` +
      `[${r.verifiedPlatforms.join(", ")}]. ` +
      "If published posts exist that are OLDER than that window, they will " +
      "never be enrolled by the scheduled sweep — use the bounded historical " +
      `backfill instead.${failedPart}`
    );
  }

  if (r.attempted === 0) {
    return (
      `${r.candidates} candidate(s) were found but none reached a provider: ` +
      `all ${r.skipped} were skipped. Skip reasons: ${summariseSkips(r)}.`
    );
  }

  if (r.succeeded === 0) {
    return (
      `${r.attempted} provider read(s) were attempted and none returned ` +
      `verified metrics (${r.unavailable} unavailable, ${r.unsupported} ` +
      `unsupported, ${r.rateLimited} rate-limited, ${r.failed} failed). ` +
      `By platform: ${summarisePlatforms(r)}.`
    );
  }

  const partial =
    r.attempted > r.succeeded
      ? ` ${r.attempted - r.succeeded} read(s) did not return verified metrics (${summarisePlatforms(r)}).`
      : "";
  const loaderNote = someLoaderFailed
    ? ` NOTE: one candidate loader failed, so coverage this run was incomplete.`
    : "";
  return (
    `${r.succeeded} of ${r.attempted} provider read(s) returned verified ` +
    `metrics across ${Object.keys(r.byWorkspace).length} workspace(s).` +
    partial +
    loaderNote
  );
}

function summarisePlatforms(r: SweepReport): string {
  const parts = Object.entries(r.byPlatform)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, t]) => {
      const detail = [
        t.connected ? `${t.connected} connected` : null,
        t.unavailable ? `${t.unavailable} unavailable` : null,
        t.unsupported ? `${t.unsupported} unsupported` : null,
        t.rateLimited ? `${t.rateLimited} rate-limited` : null,
        t.failed ? `${t.failed} failed` : null,
        t.skipped ? `${t.skipped} skipped` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `${platform} (${detail || "no activity"})`;
    });
  return parts.length > 0 ? parts.join("; ") : "none";
}

function summariseSkips(r: SweepReport): string {
  const counts = new Map<SkipReason, number>();
  for (const s of r.skips) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const parts = Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, n]) => `${reason} x${n}`);
  return parts.length > 0 ? parts.join(", ") : "not recorded";
}

/**
 * The one-line form written to stdout, so a Vercel log tail shows the
 * outcome without opening the database.
 */
export function sweepLogLine(r: SweepReport): string {
  return JSON.stringify({
    tag: "metrics-sweep",
    runId: r.runId,
    phase: r.phase,
    seedWindowDays: r.seedWindowDays,
    loaderStaleOk: r.loaders.stale.ok,
    loaderUnmeasuredOk: r.loaders.unmeasured.ok,
    candidates: r.candidates,
    attempted: r.attempted,
    succeeded: r.succeeded,
    unavailable: r.unavailable,
    unsupported: r.unsupported,
    rateLimited: r.rateLimited,
    failed: r.failed,
    skipped: r.skipped,
    durationMs: r.durationMs,
    diagnosis: r.diagnosis,
  });
}
