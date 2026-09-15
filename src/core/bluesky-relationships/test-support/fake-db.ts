/**
 * An in-memory stand-in for the Supabase client, for relationship tests.
 *
 * WHY A FAKE RATHER THAN A MOCK
 * -----------------------------
 * A `vi.fn()` that returns a canned row proves the code called the
 * database; it proves nothing about whether the database would have
 * accepted the write. Several of this milestone's invariants live in
 * the schema — the one-active-action unique index, the batch-membership
 * trigger, the completion CHECK — and a test that mocked those away
 * would pass while the real system failed.
 *
 * So this fake ENFORCES them:
 *
 *   - `unique (workspace_id, operator_account_id, subject_did)` on
 *     candidates and target profiles, so a duplicate import genuinely
 *     cannot create a second row;
 *   - the partial unique index over pending/running actions, so a
 *     second concurrent follow genuinely fails;
 *   - the BEFORE INSERT trigger that refuses an action carrying a
 *     confirmed batch id;
 *   - the CHECK that status='completed' requires cursor_exhausted.
 *
 * Each is raised with the Postgres error code or message text the real
 * database produces, because the repository layer branches on those.
 *
 * This is NOT a Postgres substitute and makes no claim to be. It does
 * not evaluate RLS, so a test asserting workspace isolation here is
 * asserting that the QUERY filters correctly — a real property, and a
 * separate one from the policy doing so. See the milestone report's
 * limitations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type Row = Record<string, unknown>;

interface PostgresError {
  code: string;
  message: string;
  details: string | null;
  hint: string | null;
}

function pgError(code: string, message: string): PostgresError {
  return { code, message, details: null, hint: null };
}

const UNIQUE_VIOLATION = "23505";

/** Postgres arithmetic on a nullable integer column: null reads as 0. */
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const CHECK_VIOLATION = "23514";

interface Filter {
  kind: "eq" | "in" | "is" | "or";
  column: string;
  value: unknown;
}

export class FakeDb {
  readonly tables = new Map<string, Row[]>();
  private idCounter = 0;
  /**
   * Natural-key → row index, per table.
   *
   * Without it `findByNaturalKey` is a linear scan and an upsert-heavy
   * import is O(n²): seeding 100,000 members took over three minutes,
   * which is long enough that a scale test stops being run. Postgres
   * has a unique INDEX behind these constraints, so a linear scan is
   * also the wrong shape to be modelling.
   */
  private readonly naturalKeyIndex = new Map<string, Map<string, Row>>();

  /**
   * The database clock.
   *
   * Postgres evaluates `now()` inside the RPCs; here that has to be the
   * SAME instant the caller passed as `nowIso`, not this machine's wall
   * clock. When they drift, every deadline test answers a question
   * nobody asked: a rate-limit reset at 13:00 on a fixed test date
   * "correctly" refused to resume simply because the real clock had not
   * reached 13:00 yet, and would have started passing or failing
   * depending on the hour the suite was run.
   */
  private clockMs: number | null = null;

  /** Pin the database clock. Tests that inject `nowIso` must call this. */
  setNow(iso: string): void {
    this.clockMs = Date.parse(iso);
  }

  /** `now()`, as the RPCs see it. */
  nowMs(): number {
    return this.clockMs ?? Date.now();
  }

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables.set(table, rows.map((r) => ({ ...r })));
    }
  }

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  nextId(prefix = "id"): string {
    this.idCounter += 1;
    return `${prefix}-${this.idCounter}`;
  }

  /** The object the code under test receives as a SupabaseClient. */
  client(): SupabaseClient {
    return {
      from: (table: string) => new FakeQuery(this, table),
      rpc: (fn: string, args: Record<string, unknown>) =>
        Promise.resolve(this.rpc(fn, args)),
    } as unknown as SupabaseClient;
  }

  /**
   * The campaign RPCs.
   *
   * Reproduced rather than mocked, because these functions ARE the
   * concurrency guarantees. A `vi.fn()` returning canned rows would
   * prove the worker called claim(); it would prove nothing about
   * whether two workers can claim the same member — which is the one
   * property worth testing.
   *
   * JavaScript is single-threaded, so a synchronous body here has
   * exactly the atomicity `FOR UPDATE SKIP LOCKED` gives inside one
   * statement: an interleaved caller cannot observe a half-applied
   * claim. Two "concurrent" workers in a test are interleaved awaits,
   * and they must come away with disjoint sets.
   */
  rpc(fn: string, args: Record<string, unknown>): QueryResult {
    switch (fn) {
      case "claim_bluesky_campaign_members":
        return this.claimCampaignMembers(args);
      case "release_bluesky_campaign_members":
        return this.releaseCampaignMembers(args, false);
      case "release_bluesky_campaign_members_owned":
        return this.releaseCampaignMembers(args, true);
      case "ensure_bluesky_campaign_run":
        return this.ensureCampaignRun(args);
      case "record_bluesky_identity_usage":
        return this.recordIdentityUsage(args);
      case "reserve_bluesky_campaign_quota":
        return this.reserveCampaignQuota(args);
      case "list_bluesky_candidates_keyset":
        return this.listCandidatesKeyset(args);
      case "list_bluesky_candidates_snapshot_keyset":
        return this.listCandidateSnapshot(args);
      case "count_bluesky_candidates_eligible":
        return this.countEligibleCandidates(args);
      case "begin_bluesky_campaign_import":
        return this.beginImportJob(args);
      case "advance_bluesky_campaign_import":
        return this.advanceImportJob(args);
      case "advance_bluesky_campaign_import_v2":
        return this.advanceImportJobV2(args);
      case "import_bluesky_campaign_member_chunk":
        return this.importCampaignMemberChunk(args);
      case "consume_bluesky_member_quota":
        return this.consumeMemberQuota(args);
      case "fold_bluesky_ledger_outcomes":
        return {
          data: this.foldLedger(String(args.p_reservation_id)),
          error: null,
        };
      case "sweep_bluesky_quota_reservations":
        this.sweepReservations(
          String(args.p_workspace_id),
          String(args.p_operator_account_id),
          String(args.p_usage_date),
        );
        return { data: 0, error: null };
      case "acquire_bluesky_run_dispatch_lease":
        return this.acquireDispatchLease(args);
      case "release_bluesky_run_dispatch_lease":
        return this.releaseDispatchLease(args);
      case "apply_bluesky_run_outcome":
        return this.applyRunOutcome(args);
      case "claim_bluesky_campaign_action":
        return this.claimCampaignAction(args);
      case "resume_bluesky_campaign_run":
        return this.resumeRun(args);
      case "resume_bluesky_campaign_run_after_recovery":
        return this.resumeRunAfterRecovery(args);
      case "reopen_bluesky_campaign_action":
        return this.reopenAction(args);
      case "bluesky_campaign_may_complete":
        return this.mayComplete(args);
      case "defer_bluesky_campaign_member":
        return this.deferMember(args);
      case "recover_bluesky_reauthorized_campaigns":
        // The identity-session coordinator lives in real PostgreSQL
        // (src/core/bluesky-campaigns/identity-session*.pg.test.ts);
        // the in-memory double has nothing to recover.
        return { data: [], error: null };
      case "stop_bluesky_campaigns_for_identity":
        return this.stopCampaignsForIdentity(args);
      default:
        return {
          data: null,
          error: pgError("42883", `function ${fn} does not exist`),
        };
    }
  }

  private claimCampaignMembers(args: Record<string, unknown>): QueryResult {
    const now = this.nowMs();
    const chunk = Math.min(
      Math.max(Number(args.p_chunk_size ?? 1), 1),
      100,
    );
    const leaseSeconds = Math.min(
      Math.max(Number(args.p_lease_seconds ?? 60), 10),
      3600,
    );

    const eligible = this.rows("bluesky_follow_campaign_members")
      .filter((m) => {
        if (m.workspace_id !== args.p_workspace_id) return false;
        if (m.campaign_id !== args.p_campaign_id) return false;
        const status = String(m.status);
        if (status === "queued" || status === "retryable") {
          const next = m.next_attempt_at as string | null;
          return !next || new Date(next).getTime() <= now;
        }
        // An expired lease returns to the pool. Safe for follows
        // because the worker reads relationship truth before
        // re-attempting.
        if (status === "claimed" || status === "running") {
          const expiry = m.lease_expires_at as string | null;
          return Boolean(expiry) && new Date(expiry!).getTime() < now;
        }
        return false;
      })
      .sort(
        (a, b) => Number(a.import_sequence) - Number(b.import_sequence),
      )
      .slice(0, chunk);

    // Applied in the same synchronous turn as the selection — this is
    // the SKIP LOCKED equivalent.
    const claimedAt = new Date(now).toISOString();
    const claimed = eligible.map((m) => {
      m.status = "claimed";
      m.claimed_at = claimedAt;
      m.claimed_by = args.p_claimed_by;
      m.lease_expires_at = new Date(now + leaseSeconds * 1000).toISOString();
      return { ...m };
    });
    return { data: claimed, error: null };
  }

  /**
   * Mirrors release_bluesky_campaign_members(_owned).
   *
   * With `checkOwnership`, a worker may hand back only the rows it
   * still holds under the reservation that paid for them. Releasing by
   * id alone let a worker whose lease had lapsed clear the lease of
   * whoever had since reclaimed the row — while a request for it may
   * have been in flight.
   */
  private releaseCampaignMembers(
    args: Record<string, unknown>,
    checkOwnership: boolean,
  ): QueryResult {
    const ids = new Set((args.p_member_ids as string[]) ?? []);
    let count = 0;
    for (const m of this.rows("bluesky_follow_campaign_members")) {
      if (m.workspace_id !== args.p_workspace_id) continue;
      if (m.campaign_id !== args.p_campaign_id) continue;
      if (!ids.has(String(m.id))) continue;
      if (m.status !== "claimed" && m.status !== "running") continue;
      if (checkOwnership) {
        if ((m.claimed_by ?? null) !== (args.p_claimed_by ?? null)) continue;
        if ((m.reservation_id ?? null) !== (args.p_reservation_id ?? null)) {
          continue;
        }
      }
      // A member that has already been attempted comes back as
      // retryable, not queued, so its history is not erased.
      m.status = num(m.attempt_count) > 0 ? "retryable" : "queued";
      m.claimed_at = null;
      m.claimed_by = null;
      m.lease_expires_at = null;
      m.reservation_id = null;
      count += 1;
    }
    return { data: count, error: null };
  }

  private ensureCampaignRun(args: Record<string, unknown>): QueryResult {
    const rows = this.rows("bluesky_follow_campaign_runs");
    // The unique (campaign_id, local_date) index. A duplicate cron
    // delivery finds this row rather than inserting a second.
    const existing = rows.find(
      (r) =>
        r.campaign_id === args.p_campaign_id &&
        r.local_date === args.p_local_date,
    );
    if (existing) return { data: existing, error: null };

    const requested = Number(args.p_requested_quota);
    const effective = Math.min(Number(args.p_effective_quota), requested);
    const row: Row = {
      id: this.nextId("run"),
      workspace_id: args.p_workspace_id,
      campaign_id: args.p_campaign_id,
      local_date: args.p_local_date,
      status: "running",
      requested_daily_quota: requested,
      effective_daily_quota: effective,
      effective_quota_reason: args.p_effective_reason ?? null,
      attempted_count: 0,
      succeeded_count: 0,
      already_following_count: 0,
      skipped_count: 0,
      failed_count: 0,
      consecutive_failures: 0,
      reserved_count: 0,
      rate_limited_until: null,
      rate_limit_remaining: null,
      rate_limit_reset_at: null,
      last_error_code: null,
      last_error_message: null,
      started_at: new Date().toISOString(),
      completed_at: null,
      last_chunk_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    rows.push(row);
    return { data: row, error: null };
  }

  /**
   * Reserve quota AND claim that many members, atomically.
   *
   * Mirrors `reserve_bluesky_campaign_quota`. The body is synchronous,
   * which in a single-threaded runtime gives the same guarantee the
   * real function gets from its row locks: an interleaved caller cannot
   * observe a half-applied reservation. That is what makes the
   * concurrent-dispatcher test meaningful rather than decorative.
   */
  /**
   * Mirrors reserve_bluesky_campaign_quota.
   *
   * Outstanding quota is read from RESERVATION ROWS, never inferred
   * from member lease status. That inference was the defect: the worker
   * clears each member's lease as it finishes, so between the last
   * member and settlement the quota is spent while nothing on the
   * member rows says so, and a second worker would "correct" the
   * reserved count to zero and hand out the whole day again.
   */
  private reserveCampaignQuota(args: Record<string, unknown>): QueryResult {
    const nothing = (reason: string): QueryResult => ({
      data: [{ reserved: 0, reservation_id: null, reason, member_id: null }],
      error: null,
    });

    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) => r.id === args.p_run_id && r.workspace_id === args.p_workspace_id,
    );
    if (!run) return nothing("run_missing");
    if (run.status !== "running") return nothing("run_not_running");

    const usageRows = this.rows("bluesky_identity_daily_usage");
    let usage = usageRows.find(
      (u) =>
        u.workspace_id === args.p_workspace_id &&
        u.operator_account_id === args.p_operator_account_id &&
        u.usage_date === args.p_usage_date,
    );
    if (!usage) {
      usage = {
        id: this.nextId("usage"),
        workspace_id: args.p_workspace_id,
        operator_account_id: args.p_operator_account_id,
        usage_date: args.p_usage_date,
        follows_created: 0,
        attempts_made: 0,
        reserved_count: 0,
      };
      usageRows.push(usage);
    }

    this.sweepReservations(
      String(args.p_workspace_id),
      String(args.p_operator_account_id),
      String(args.p_usage_date),
    );

    const reservations = this.rows("bluesky_campaign_quota_reservations");
    const now0 = this.nowMs();
    const lease0 = Math.min(Math.max(num(args.p_lease_seconds) || 60, 10), 3600);

    // RECONCILIATION TAKEOVER, before any quota arithmetic.
    //
    // A member whose action is unresolved has ALREADY spent its unit —
    // provider_intent_at is stamped and the unit left its reservation
    // at that moment. Reconciling reads truth and can never mutate, so
    // it costs nothing more and must not compete for headroom.
    //
    // Requiring headroom here deadlocks exactly when it matters: a
    // campaign that has spent its whole quota could never claim the
    // member whose outcome is still unknown.
    const ledgerRows = this.rows("bluesky_campaign_attempt_ledger");
    const actionRows = this.rows("bluesky_relationship_actions");
    const stranded = this.rows("bluesky_follow_campaign_members")
      .filter(
        (m) =>
          m.workspace_id === args.p_workspace_id &&
          m.campaign_id === args.p_campaign_id &&
          // Whatever state the member is IN. A worker that reconciles
          // without learning anything persists it as `retryable`, and
          // matching only leased rows meant such a member could never
          // be picked up again: the takeover skipped it, and the
          // ordinary path wanted quota it does not need.
          (((m.status === "claimed" || m.status === "running") &&
            m.lease_expires_at !== null &&
            new Date(String(m.lease_expires_at)).getTime() < now0) ||
            ((m.status === "queued" || m.status === "retryable") &&
              (!m.next_attempt_at ||
                new Date(String(m.next_attempt_at)).getTime() <= now0))) &&
          ledgerRows.some(
            (l) => l.member_id === m.id && l.provider_intent_at,
          ) &&
          actionRows.some(
            (a) =>
              a.campaign_member_id === m.id &&
              !["succeeded", "failed", "skipped"].includes(String(a.status)),
          ),
      )
      .sort((a, b) => Number(a.import_sequence) - Number(b.import_sequence))
      .slice(0, Math.min(Math.max(num(args.p_chunk_size) || 1, 1), 100));

    if (stranded.length > 0) {
      // A ZERO-unit reservation: a real reservation that owns the
      // settlement and carries the ledger rows, promising no new quota.
      const reconcileId = this.nextId("reservation");
      reservations.push({
        id: reconcileId,
        workspace_id: args.p_workspace_id,
        campaign_id: args.p_campaign_id,
        run_id: args.p_run_id,
        operator_account_id: args.p_operator_account_id,
        usage_date: args.p_usage_date,
        reserved_count: 0,
        status: "open",
        claimed_by: args.p_claimed_by ?? null,
        expires_at: new Date(now0 + lease0 * 1000).toISOString(),
        settled_at: null,
      });
      for (const m of stranded) {
        m.status = "claimed";
        m.claimed_at = new Date(now0).toISOString();
        m.claimed_by = args.p_claimed_by ?? null;
        m.reservation_id = reconcileId;
        m.lease_expires_at = new Date(now0 + lease0 * 1000).toISOString();
        ledgerRows.push({
          id: this.nextId("ledger"),
          workspace_id: args.p_workspace_id,
          campaign_id: args.p_campaign_id,
          run_id: args.p_run_id,
          operator_account_id: args.p_operator_account_id,
          usage_date: args.p_usage_date,
          reservation_id: reconcileId,
          member_id: m.id,
          action_id: null,
          provider_intent_at: null,
          counted_at: null,
        });
      }
      return {
        data: stranded.map((m) => ({
          reserved: 0,
          reservation_id: reconcileId,
          reason: "reconcile",
          member_id: m.id,
          subject_did: m.subject_did,
          current_handle: m.current_handle ?? null,
          import_sequence: m.import_sequence,
          attempt_count: m.attempt_count ?? 0,
          provider_record_rkey: m.provider_record_rkey ?? null,
        })),
        error: null,
      };
    }

    const outstanding = (predicate: (r: Row) => boolean) =>
      reservations
        .filter((r) => predicate(r) && (r.status === "open" || r.status === "held"))
        .reduce((sum, r) => sum + num(r.reserved_count), 0);

    const runReserved = outstanding((r) => r.run_id === args.p_run_id);
    const identityReserved = outstanding(
      (r) =>
        r.workspace_id === args.p_workspace_id &&
        r.operator_account_id === args.p_operator_account_id &&
        r.usage_date === args.p_usage_date,
    );

    // `attempted_count` is now exactly the units DURABLY consumed —
    // incremented at provider intent, one member at a time. So headroom
    // is the plain subtraction, with no correction terms: neither a dry
    // run nor an ineligible account reaches provider intent, so neither
    // is counted and subtracting skips would credit back quota that was
    // never taken.
    const runHeadroom = Math.max(
      0,
      num(run.effective_daily_quota) - num(run.attempted_count) - runReserved,
    );
    // The identity is bounded by ATTEMPTS, not records created: a
    // failed follow still cost provider budget, and so did one whose
    // outcome was never learned.
    const identityHeadroom = Math.max(
      0,
      num(args.p_identity_ceiling) -
        Math.max(num(usage.attempts_made), num(usage.follows_created)) -
        identityReserved,
    );
    const grant = Math.min(
      Math.max(num(args.p_requested), 0),
      runHeadroom,
      identityHeadroom,
      Math.min(Math.max(num(args.p_chunk_size) || 1, 1), 100),
    );

    run.reserved_count = runReserved;
    usage.reserved_count = identityReserved;

    if (grant <= 0) {
      if (runHeadroom <= 0) return nothing("quota_exhausted");
      if (identityHeadroom <= 0) return nothing("identity_exhausted");
      return nothing("nothing_requested");
    }

    const now = this.nowMs();
    const leaseSeconds = Math.min(
      Math.max(num(args.p_lease_seconds) || 60, 10),
      3600,
    );

    const eligible = this.rows("bluesky_follow_campaign_members")
      .filter((m) => {
        if (m.workspace_id !== args.p_workspace_id) return false;
        if (m.campaign_id !== args.p_campaign_id) return false;
        const status = String(m.status);
        if (status === "queued" || status === "retryable") {
          const next = m.next_attempt_at as string | null;
          return !next || new Date(next).getTime() <= now;
        }
        if (status === "claimed" || status === "running") {
          const expiry = m.lease_expires_at as string | null;
          return Boolean(expiry) && new Date(expiry!).getTime() < now;
        }
        return false;
      })
      .sort((a, b) => Number(a.import_sequence) - Number(b.import_sequence))
      .slice(0, grant);

    if (eligible.length === 0) return nothing("queue_empty");

    const reservationId = this.nextId("reservation");
    reservations.push({
      id: reservationId,
      workspace_id: args.p_workspace_id,
      campaign_id: args.p_campaign_id,
      run_id: args.p_run_id,
      operator_account_id: args.p_operator_account_id,
      usage_date: args.p_usage_date,
      reserved_count: eligible.length,
      status: "open",
      claimed_by: args.p_claimed_by ?? null,
      expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
      settled_at: null,
    });

    for (const m of eligible) {
      m.status = "claimed";
      m.claimed_at = new Date(now).toISOString();
      m.claimed_by = args.p_claimed_by ?? null;
      m.reservation_id = reservationId;
      m.lease_expires_at = new Date(now + leaseSeconds * 1000).toISOString();
      // A ledger row with NO intent yet. Intent — and with it the unit
      // of quota — is stamped only when the worker is about to call the
      // provider.
      this.rows("bluesky_campaign_attempt_ledger").push({
        id: this.nextId("ledger"),
        workspace_id: args.p_workspace_id,
        campaign_id: args.p_campaign_id,
        run_id: args.p_run_id,
        operator_account_id: args.p_operator_account_id,
        usage_date: args.p_usage_date,
        reservation_id: reservationId,
        member_id: m.id,
        action_id: null,
        provider_intent_at: null,
        counted_at: null,
      });
    }

    run.reserved_count = runReserved + eligible.length;
    usage.reserved_count = identityReserved + eligible.length;

    return {
      data: eligible.map((m) => ({
        reserved: eligible.length,
        reservation_id: reservationId,
        reason: "granted",
        member_id: m.id,
        subject_did: m.subject_did,
        current_handle: m.current_handle ?? null,
        import_sequence: m.import_sequence,
        attempt_count: m.attempt_count ?? 0,
        provider_record_rkey: m.provider_record_rkey ?? null,
      })),
      error: null,
    };
  }

  /**
   * Mirrors fold_bluesky_ledger_outcomes.
   *
   * Recovery reads the DURABLE rows the worker was writing as it went,
   * not totals it held in memory — a worker that dies has no totals.
   * Idempotent through `counted_at`.
   */
  private foldLedger(reservationId: string): number {
    const reservation = this.rows("bluesky_campaign_quota_reservations").find(
      (r) => r.id === reservationId,
    );
    if (!reservation) return 0;
    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) => r.id === reservation.run_id,
    );
    if (!run) return 0;

    const pending = this.rows("bluesky_campaign_attempt_ledger").filter(
      (l) => l.reservation_id === reservationId && !l.counted_at,
    );
    if (pending.length === 0) return 0;

    const actions = this.rows("bluesky_relationship_actions");
    let succeeded = 0;
    let already = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of pending) {
      // The action this attempt actually paid for. Matching on
      // member_id alone matched an older skipped attempt as well as the
      // real one, and which of the two won was left to chance — the
      // measured result recorded the SKIP and dropped the success.
      //
      // The legacy fallback, for rows written before the id was
      // recorded, is explicit and totally ordered: a real attempt
      // outranks a skip, then the most recent, then the id. It resolves
      // to exactly one action or to none.
      const action = row.action_id
        ? actions.find((a) => a.id === row.action_id)
        : actions
            .filter(
              (a) =>
                a.campaign_member_id === row.member_id &&
                a.campaign_id === row.campaign_id,
            )
            .sort((x, y) => {
              const rank = (a: Row) => (a.status === "skipped" ? 1 : 0);
              if (rank(x) !== rank(y)) return rank(x) - rank(y);
              const t =
                String(y.created_at ?? "").localeCompare(String(x.created_at ?? ""));
              if (t !== 0) return t;
              return String(x.id).localeCompare(String(y.id));
            })[0];
      const status = action ? String(action.status) : null;
      if (status === "succeeded" && action?.follow_uri) succeeded += 1;
      else if (status === "succeeded") already += 1;
      else if (status === "failed") failed += 1;
      else if (status === "skipped") skipped += 1;
      // Anything else is UNKNOWN: counted as no outcome, but its unit
      // was spent at provider intent and is never returned.
      row.counted_at = new Date(this.nowMs()).toISOString();
    }

    // attempted_count is NOT touched: it was incremented at provider
    // intent, one member at a time, which is why attempts survive a
    // crash.
    run.succeeded_count = num(run.succeeded_count) + succeeded;
    run.already_following_count = num(run.already_following_count) + already;
    run.failed_count = num(run.failed_count) + failed;
    run.skipped_count = num(run.skipped_count) + skipped;
    run.last_chunk_at = new Date(this.nowMs()).toISOString();

    const usage = this.rows("bluesky_identity_daily_usage").find(
      (u) =>
        u.workspace_id === reservation.workspace_id &&
        u.operator_account_id === reservation.operator_account_id &&
        u.usage_date === reservation.usage_date,
    );
    if (usage) {
      usage.follows_created = num(usage.follows_created) + succeeded;
    }
    return pending.length;
  }

  /**
   * Mirrors consume_bluesky_member_quota.
   *
   * The last thing before the provider call: converts one reserved unit
   * into a durable attempted one and stamps an IMMUTABLE marker. After
   * this the quota is spent whatever happens to this worker.
   */
  private consumeMemberQuota(args: Record<string, unknown>): QueryResult {
    const answer = (
      consumed: boolean,
      alreadyConsumed: boolean,
      reason: string | null,
    ): QueryResult => ({
      data: [
        { consumed, already_consumed: alreadyConsumed, refused_reason: reason },
      ],
      error: null,
    });

    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) =>
        r.id === args.p_run_id &&
        r.workspace_id === args.p_workspace_id &&
        r.campaign_id === args.p_campaign_id,
    );
    if (!run) return answer(false, false, "unknown_run");

    const reservation = this.rows("bluesky_campaign_quota_reservations").find(
      (r) => r.id === args.p_reservation_id,
    );
    if (!reservation) return answer(false, false, "unknown_reservation");
    if (reservation.workspace_id !== args.p_workspace_id) {
      return answer(false, false, "workspace_mismatch");
    }
    if (reservation.campaign_id !== args.p_campaign_id) {
      return answer(false, false, "campaign_mismatch");
    }
    if (reservation.run_id !== args.p_run_id) {
      return answer(false, false, "run_mismatch");
    }
    if (reservation.operator_account_id !== args.p_operator_account_id) {
      return answer(false, false, "identity_mismatch");
    }
    // A settled or expired reservation cannot fund anything: its quota
    // has already been accounted for and returned.
    if (reservation.status !== "open") {
      return answer(false, false, `reservation_${String(reservation.status)}`);
    }

    const member = this.rows("bluesky_follow_campaign_members").find(
      (m) =>
        m.id === args.p_member_id &&
        m.workspace_id === args.p_workspace_id &&
        m.campaign_id === args.p_campaign_id,
    );
    if (!member) return answer(false, false, "member_mismatch");

    const ledger = this.rows("bluesky_campaign_attempt_ledger");
    const existing = ledger.find(
      (l) =>
        l.reservation_id === args.p_reservation_id &&
        l.member_id === args.p_member_id,
    );
    if (existing?.provider_intent_at) return answer(false, true, null);
    if (num(reservation.reserved_count) <= 0) {
      return answer(false, false, "reservation_exhausted");
    }

    const action = this.rows("bluesky_relationship_actions").find(
      (a) => a.id === args.p_action_id,
    );
    if (!action) return answer(false, false, "unknown_action");
    if (
      action.workspace_id !== args.p_workspace_id ||
      action.campaign_id !== args.p_campaign_id ||
      action.campaign_member_id !== args.p_member_id
    ) {
      return answer(false, false, "action_mismatch");
    }
    if (
      ["succeeded", "failed", "reconciliation_required"].includes(
        String(action.status),
      )
    ) {
      return answer(false, false, "action_terminal");
    }

    // Everything below is one transaction: both markers, both counters
    // and the reservation move together or not at all.
    const now = new Date(this.nowMs()).toISOString();
    if (existing) {
      existing.provider_intent_at = now;
      existing.action_id = args.p_action_id;
    } else {
      ledger.push({
        id: this.nextId("ledger"),
        workspace_id: reservation.workspace_id,
        campaign_id: reservation.campaign_id,
        run_id: reservation.run_id,
        operator_account_id: reservation.operator_account_id,
        usage_date: reservation.usage_date,
        reservation_id: args.p_reservation_id,
        member_id: args.p_member_id,
        action_id: args.p_action_id,
        provider_intent_at: now,
        counted_at: null,
      });
    }

    // The marker goes up HERE, one statement before the request, so it
    // can never describe a mutation that was not attempted.
    action.provider_in_flight_at = now;
    action.started_at = action.started_at ?? now;

    reservation.reserved_count = num(reservation.reserved_count) - 1;
    run.attempted_count = num(run.attempted_count) + 1;
    run.reserved_count = Math.max(num(run.reserved_count) - 1, 0);

    const usage = this.rows("bluesky_identity_daily_usage").find(
      (u) =>
        u.workspace_id === reservation.workspace_id &&
        u.operator_account_id === reservation.operator_account_id &&
        u.usage_date === reservation.usage_date,
    );
    if (usage) {
      usage.attempts_made = num(usage.attempts_made) + 1;
      usage.reserved_count = Math.max(num(usage.reserved_count) - 1, 0);
    }
    return answer(true, false, null);
  }

  /**
   * Mirrors sweep_bluesky_quota_reservations.
   *
   * Fold first, then release what is LEFT — which is only ever units
   * that never reached provider intent, because every unit that did was
   * taken off the reservation at that moment.
   */
  private sweepReservations(
    workspaceId: string,
    operatorAccountId: string,
    usageDate: string,
  ): void {
    const now = this.nowMs();
    for (const r of this.rows("bluesky_campaign_quota_reservations")) {
      if (
        r.workspace_id !== workspaceId ||
        r.operator_account_id !== operatorAccountId ||
        r.usage_date !== usageDate ||
        r.status !== "open" ||
        new Date(String(r.expires_at)).getTime() >= now
      ) {
        continue;
      }
      this.foldLedger(String(r.id));
      r.status = "expired";
      r.reserved_count = 0;
    }
  }

  /**
   * Mirrors apply_bluesky_run_outcome: fold the ledger, validate the
   * WHOLE tenant tuple, settle exactly once.
   */
  private applyRunOutcome(args: Record<string, unknown>): QueryResult {
    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) => r.id === args.p_run_id && r.workspace_id === args.p_workspace_id,
    );

    const answer = (
      settled: boolean,
      alreadySettled: boolean,
      reason: string | null,
    ): QueryResult => ({
      data: [
        {
          settled,
          already_settled: alreadySettled,
          refused_reason: reason,
          out_run_id: run?.id ?? null,
          out_attempted: run ? num(run.attempted_count) : 0,
          out_succeeded: run ? num(run.succeeded_count) : 0,
          out_reserved: run ? num(run.reserved_count) : 0,
        },
      ],
      error: null,
    });

    if (!run) return answer(false, false, "unknown_run");

    const reservation = this.rows("bluesky_campaign_quota_reservations").find(
      (r) => r.id === args.p_reservation_id,
    );

    // Each of these is a DISTINCT budget. Checking only the run left a
    // reservation from another workspace, campaign, identity or day
    // able to settle against this one.
    if (!reservation) return answer(false, false, "unknown_reservation");
    if (reservation.workspace_id !== args.p_workspace_id) {
      return answer(false, false, "workspace_mismatch");
    }
    if (reservation.campaign_id !== args.p_campaign_id) {
      return answer(false, false, "campaign_mismatch");
    }
    if (reservation.run_id !== args.p_run_id) {
      return answer(false, false, "run_mismatch");
    }
    if (reservation.operator_account_id !== args.p_operator_account_id) {
      return answer(false, false, "identity_mismatch");
    }
    if (reservation.usage_date !== args.p_usage_date) {
      return answer(false, false, "usage_date_mismatch");
    }
    if (reservation.status === "settled") return answer(false, true, null);

    this.foldLedger(String(reservation.id));

    reservation.status = "settled";
    reservation.settled_at = new Date(this.nowMs()).toISOString();
    reservation.reserved_count = 0;

    run.consecutive_failures = num(args.p_consecutive_failures);
    if (args.p_rate_limited_until) {
      run.rate_limited_until = args.p_rate_limited_until;
      run.status = "rate_limited";
    }
    if (
      args.p_rate_limit_remaining !== null &&
      args.p_rate_limit_remaining !== undefined
    ) {
      run.rate_limit_remaining = args.p_rate_limit_remaining;
    }
    if (args.p_rate_limit_reset_at) {
      run.rate_limit_reset_at = args.p_rate_limit_reset_at;
    }
    run.last_chunk_at = new Date(this.nowMs()).toISOString();

    const open = this.rows("bluesky_campaign_quota_reservations").filter(
      (r) => r.status === "open" || r.status === "held",
    );
    run.reserved_count = open
      .filter((r) => r.run_id === args.p_run_id)
      .reduce((sum, r) => sum + num(r.reserved_count), 0);
    const usage = this.rows("bluesky_identity_daily_usage").find(
      (u) =>
        u.workspace_id === args.p_workspace_id &&
        u.operator_account_id === args.p_operator_account_id &&
        u.usage_date === args.p_usage_date,
    );
    if (usage) {
      usage.reserved_count = open
        .filter(
          (r) =>
            r.workspace_id === args.p_workspace_id &&
            r.operator_account_id === args.p_operator_account_id &&
            r.usage_date === args.p_usage_date,
        )
        .reduce((sum, r) => sum + num(r.reserved_count), 0);
    }

    return answer(true, false, null);
  }

  /**
   * Mirrors list_bluesky_candidates_keyset.
   *
   * The total order is (last_discovered_at desc, subject_did asc). The
   * DID is the tie-breaker and is unique within (workspace, identity),
   * so no two rows share a position — which is what makes a keyset walk
   * unable to skip or repeat a row, unlike the OFFSET paging this
   * replaced.
   */
  private listCandidatesKeyset(args: Record<string, unknown>): QueryResult {
    const states = (args.p_states as string[] | null) ?? null;
    const targetId = args.p_target_profile_id ?? null;
    const afterAt = args.p_after_last_discovered_at as string | null;
    const afterDid = args.p_after_subject_did as string | null;
    const limit = Math.min(Math.max(num(args.p_limit) || 500, 1), 1000);

    const sources = this.rows("bluesky_candidate_sources");
    const rows = this.rows("bluesky_candidates")
      .filter((c) => {
        if (c.workspace_id !== args.p_workspace_id) return false;
        if (c.operator_account_id !== args.p_operator_account_id) return false;
        if (states && !states.includes(String(c.relationship_state))) return false;
        if (targetId) {
          const linked = sources.some(
            (s) => s.candidate_id === c.id && s.target_profile_id === targetId,
          );
          if (!linked) return false;
        }
        if (afterAt) {
          const at = String(c.last_discovered_at);
          if (at > afterAt) return false;
          if (at === afterAt && String(c.subject_did) <= String(afterDid)) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const t = String(b.last_discovered_at).localeCompare(
          String(a.last_discovered_at),
        );
        if (t !== 0) return t;
        return String(a.subject_did).localeCompare(String(b.subject_did));
      })
      .slice(0, limit)
      .map((c) => ({
        subject_did: c.subject_did,
        handle: c.handle ?? null,
        display_name: c.display_name ?? null,
        last_discovered_at: c.last_discovered_at,
        protected: c.protected === true,
      }));

    return { data: rows, error: null };
  }

  /** Mirrors the immutable, finite candidate snapshot walk. */
  private listCandidateSnapshot(args: Record<string, unknown>): QueryResult {
    const states = (args.p_states as string[] | null) ?? null;
    const targetId = args.p_target_profile_id ?? null;
    const snapshotAt = String(args.p_snapshot_at);
    const afterAt = args.p_after_first_discovered_at as string | null;
    const afterDid = args.p_after_subject_did as string | null;
    const limit = Math.min(Math.max(num(args.p_limit) || 500, 1), 1000);
    const sources = this.rows("bluesky_candidate_sources");

    const rows = this.rows("bluesky_candidates")
      .filter((c) => {
        if (c.workspace_id !== args.p_workspace_id) return false;
        if (c.operator_account_id !== args.p_operator_account_id) return false;
        if (states && !states.includes(String(c.relationship_state))) return false;
        const at = String(c.first_discovered_at ?? c.last_discovered_at);
        if (at > snapshotAt) return false;
        if (targetId) {
          const linked = sources.some(
            (s) =>
              s.candidate_id === c.id &&
              s.target_profile_id === targetId &&
              String(s.first_seen_at ?? at) <= snapshotAt,
          );
          if (!linked) return false;
        }
        if (afterAt) {
          if (at < afterAt) return false;
          if (at === afterAt && String(c.subject_did) <= String(afterDid)) {
            return false;
          }
        }
        return true;
      })
      .sort((a, b) => {
        const aAt = String(a.first_discovered_at ?? a.last_discovered_at);
        const bAt = String(b.first_discovered_at ?? b.last_discovered_at);
        const t = aAt.localeCompare(bAt);
        if (t !== 0) return t;
        return String(a.subject_did).localeCompare(String(b.subject_did));
      })
      .slice(0, limit)
      .map((c) => ({
        subject_did: c.subject_did,
        handle: c.handle ?? null,
        display_name: c.display_name ?? null,
        first_discovered_at: c.first_discovered_at ?? c.last_discovered_at,
        protected: c.protected === true,
      }));

    return { data: rows, error: null };
  }

  /** Mirrors count_bluesky_candidates_eligible. */
  private countEligibleCandidates(args: Record<string, unknown>): QueryResult {
    const states = (args.p_states as string[] | null) ?? null;
    const targetId = args.p_target_profile_id ?? null;
    const sources = this.rows("bluesky_candidate_sources");
    let eligible = 0;
    let protectedExcluded = 0;
    for (const c of this.rows("bluesky_candidates")) {
      if (c.workspace_id !== args.p_workspace_id) continue;
      if (c.operator_account_id !== args.p_operator_account_id) continue;
      if (states && !states.includes(String(c.relationship_state))) continue;
      if (targetId) {
        const linked = sources.some(
          (s) => s.candidate_id === c.id && s.target_profile_id === targetId,
        );
        if (!linked) continue;
      }
      if (c.protected === true) protectedExcluded += 1;
      else eligible += 1;
    }
    return {
      data: [{ eligible, protected_excluded: protectedExcluded }],
      error: null,
    };
  }

  /**
   * Mirrors begin_bluesky_campaign_import.
   *
   * One job per campaign, and it refuses to change source: a queue half
   * built from one list and half from another is not something an
   * operator can reason about.
   */
  private beginImportJob(args: Record<string, unknown>): QueryResult {
    const jobs = this.rows("bluesky_campaign_import_jobs");
    let job = jobs.find((j) => j.campaign_id === args.p_campaign_id);

    if (!job) {
      job = {
        id: this.nextId("import-job"),
        workspace_id: args.p_workspace_id,
        campaign_id: args.p_campaign_id,
        source_kind: args.p_source_kind,
        target_profile_id: args.p_target_profile_id ?? null,
        status: "running",
        cursor_last_discovered_at: null,
        cursor_first_discovered_at: null,
        cursor_subject_did: null,
        snapshot_at: new Date(this.nowMs()).toISOString(),
        provider_cursor: null,
        source_exhausted: false,
        imported_count: 0,
        duplicate_count: 0,
        excluded_count: 0,
        pages_read: 0,
        last_error: null,
      };
      jobs.push(job);
    } else if (job.workspace_id !== args.p_workspace_id) {
      return {
        data: [{ out_refused_reason: "workspace_mismatch" }],
        error: null,
      };
    } else if (
      job.source_kind !== args.p_source_kind ||
      (job.target_profile_id ?? null) !== (args.p_target_profile_id ?? null)
    ) {
      return {
        data: [
          {
            out_job_id: job.id,
            out_source_kind: job.source_kind,
            out_target_profile_id: job.target_profile_id,
            out_refused_reason: "source_mismatch",
          },
        ],
        error: null,
      };
    } else if (job.status === "failed") {
      // A retry resumes from the checkpoint rather than starting over.
      job.status = "running";
      job.last_error = null;
    }

    return {
      data: [
        {
          out_job_id: job.id,
          out_status: job.status,
          out_source_kind: job.source_kind,
          out_target_profile_id: job.target_profile_id,
          out_cursor_at: job.cursor_last_discovered_at,
          out_cursor_did: job.cursor_subject_did,
          out_provider_cursor: job.provider_cursor,
          out_source_exhausted: job.source_exhausted,
          out_imported: job.imported_count,
          out_duplicates: job.duplicate_count,
          out_excluded: job.excluded_count,
          out_refused_reason: null,
        },
      ],
      error: null,
    };
  }

  /**
   * Mirrors advance_bluesky_campaign_import.
   *
   * The checkpoint only ever moves FORWARD in the scan order, so two
   * callers that read the same position do the same work — harmless,
   * because the unique index deduplicates — and the slower one cannot
   * rewind the walk.
   */
  private advanceImportJob(args: Record<string, unknown>): QueryResult {
    const job = this.rows("bluesky_campaign_import_jobs").find(
      (j) => j.id === args.p_job_id && j.workspace_id === args.p_workspace_id,
    );
    if (!job) return { data: [], error: null };

    const newAt = args.p_cursor_last_discovered_at as string | null;
    const newDid = args.p_cursor_subject_did as string | null;
    const oldAt = job.cursor_last_discovered_at as string | null;
    const oldDid = job.cursor_subject_did as string | null;
    const advance =
      newAt !== null &&
      newAt !== undefined &&
      (!oldAt ||
        newAt < oldAt ||
        (newAt === oldAt && String(newDid) > String(oldDid)));

    if (advance) {
      job.cursor_last_discovered_at = newAt;
      job.cursor_subject_did = newDid;
    }
    if (args.p_provider_cursor !== null && args.p_provider_cursor !== undefined) {
      job.provider_cursor = args.p_provider_cursor;
    }
    job.imported_count = num(job.imported_count) + Math.max(num(args.p_inserted), 0);
    job.duplicate_count =
      num(job.duplicate_count) + Math.max(num(args.p_duplicates), 0);
    job.excluded_count = num(job.excluded_count) + Math.max(num(args.p_excluded), 0);
    job.pages_read = num(job.pages_read) + Math.max(num(args.p_pages), 0);
    job.source_exhausted =
      job.source_exhausted === true || args.p_source_exhausted === true;
    job.last_error = args.p_error ?? null;
    job.status = args.p_error
      ? "failed"
      : job.source_exhausted
        ? "ready"
        : "running";

    return {
      data: [
        {
          out_status: job.status,
          out_cursor_at: job.cursor_last_discovered_at,
          out_cursor_did: job.cursor_subject_did,
          out_provider_cursor: job.provider_cursor,
          out_source_exhausted: job.source_exhausted,
          out_imported: job.imported_count,
          out_duplicates: job.duplicate_count,
          out_excluded: job.excluded_count,
        },
      ],
      error: null,
    };
  }

  /** Mirrors advance_bluesky_campaign_import_v2. */
  private advanceImportJobV2(args: Record<string, unknown>): QueryResult {
    const job = this.rows("bluesky_campaign_import_jobs").find(
      (j) => j.id === args.p_job_id && j.workspace_id === args.p_workspace_id,
    );
    if (!job) return { data: [], error: null };

    const newAt = args.p_cursor_first_discovered_at as string | null;
    const newDid = args.p_cursor_subject_did as string | null;
    const oldAt = job.cursor_first_discovered_at as string | null;
    const oldDid = job.cursor_subject_did as string | null;
    const advance =
      Boolean(newAt) &&
      (!oldAt ||
        String(newAt) > oldAt ||
        (String(newAt) === oldAt && String(newDid) > String(oldDid)));

    if (advance) {
      job.cursor_first_discovered_at = newAt;
      job.cursor_subject_did = newDid;
    }
    if (args.p_source_exhausted === true) job.provider_cursor = null;
    else if (args.p_provider_cursor !== null && args.p_provider_cursor !== undefined) {
      job.provider_cursor = args.p_provider_cursor;
    }
    job.imported_count = num(job.imported_count) + Math.max(num(args.p_inserted), 0);
    job.duplicate_count =
      num(job.duplicate_count) + Math.max(num(args.p_duplicates), 0);
    job.excluded_count = num(job.excluded_count) + Math.max(num(args.p_excluded), 0);
    job.pages_read = num(job.pages_read) + Math.max(num(args.p_pages), 0);
    job.source_exhausted =
      job.source_exhausted === true || args.p_source_exhausted === true;
    job.last_error = args.p_error ?? null;
    job.status = args.p_error
      ? "failed"
      : job.source_exhausted
        ? "ready"
        : "running";

    return {
      data: [
        {
          out_status: job.status,
          out_cursor_at: job.cursor_first_discovered_at,
          out_cursor_did: job.cursor_subject_did,
          out_provider_cursor: job.provider_cursor,
          out_source_exhausted: job.source_exhausted,
          out_imported: job.imported_count,
          out_duplicates: job.duplicate_count,
          out_excluded: job.excluded_count,
        },
      ],
      error: null,
    };
  }

  /** Mirrors the campaign-locked sequence allocator and chunk insert. */
  private importCampaignMemberChunk(args: Record<string, unknown>): QueryResult {
    const campaign = this.rows("bluesky_follow_campaigns").find(
      (c) => c.id === args.p_campaign_id && c.workspace_id === args.p_workspace_id,
    );
    if (!campaign) return { data: [], error: null };

    const supplied = Array.isArray(args.p_members)
      ? (args.p_members as Record<string, unknown>[])
      : [];
    const unique = new Map<string, Record<string, unknown>>();
    for (const member of supplied) {
      const did = String(member.subject_did ?? "");
      if (did.startsWith("did:") && !unique.has(did)) unique.set(did, member);
    }

    const members = this.rows("bluesky_follow_campaign_members");
    let sequence = members
      .filter((m) => m.campaign_id === args.p_campaign_id)
      .reduce((max, m) => Math.max(max, num(m.import_sequence)), 0);
    let inserted = 0;
    for (const [did, member] of [...unique].sort(([a], [b]) => a.localeCompare(b))) {
      let row = members.find(
        (m) => m.campaign_id === args.p_campaign_id && m.subject_did === did,
      );
      if (!row) {
        sequence += 1;
        row = {
          id: this.nextId("campaign-member"),
          workspace_id: args.p_workspace_id,
          campaign_id: args.p_campaign_id,
          subject_did: did,
          current_handle: member.current_handle ?? null,
          display_name: member.display_name ?? null,
          import_sequence: sequence,
          status: "queued",
          attempt_count: 0,
        };
        members.push(row);
        inserted += 1;
      }

      const sourceRows = this.rows("bluesky_campaign_member_sources");
      const targetId = member.target_profile_id ?? null;
      const label = member.source_label ?? "import";
      if (
        !sourceRows.some(
          (s) =>
            s.member_id === row!.id &&
            (s.target_profile_id ?? null) === targetId &&
            s.source_label === label,
        )
      ) {
        sourceRows.push({
          id: this.nextId("campaign-source"),
          workspace_id: args.p_workspace_id,
          member_id: row.id,
          target_profile_id: targetId,
          source_label: label,
        });
      }
    }

    return {
      data: [
        {
          out_inserted: inserted,
          out_duplicates: unique.size - inserted,
          out_last_sequence: sequence,
        },
      ],
      error: null,
    };
  }

  /** Mirrors acquire_bluesky_run_dispatch_lease. */
  private acquireDispatchLease(args: Record<string, unknown>): QueryResult {
    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) => r.id === args.p_run_id && r.workspace_id === args.p_workspace_id,
    );
    if (!run) return { data: false, error: null };
    const expiry = run.dispatch_lease_expires_at as string | null | undefined;
    const free =
      !run.dispatch_lease_owner ||
      run.dispatch_lease_owner === args.p_owner ||
      !expiry ||
      new Date(expiry).getTime() < this.nowMs();
    if (!free) return { data: false, error: null };
    const seconds = Math.min(
      Math.max(num(args.p_lease_seconds) || 60, 10),
      3600,
    );
    run.dispatch_lease_owner = args.p_owner;
    run.dispatch_lease_expires_at = new Date(
      this.nowMs() + seconds * 1000,
    ).toISOString();
    return { data: true, error: null };
  }

  /** Mirrors release_bluesky_run_dispatch_lease. */
  private releaseDispatchLease(args: Record<string, unknown>): QueryResult {
    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) => r.id === args.p_run_id && r.workspace_id === args.p_workspace_id,
    );
    if (run && run.dispatch_lease_owner === args.p_owner) {
      run.dispatch_lease_owner = null;
      run.dispatch_lease_expires_at = null;
    }
    return { data: null, error: null };
  }

  /** Mirrors claim_bluesky_campaign_action, including the in-flight rule. */
  private claimCampaignAction(args: Record<string, unknown>): QueryResult {
    const rows = this.rows("bluesky_relationship_actions");
    const existing = rows.find(
      (r) =>
        r.campaign_id === args.p_campaign_id &&
        r.campaign_member_id === args.p_member_id &&
        r.status !== "skipped",
    );

    if (existing) {
      const terminal = ["succeeded", "failed", "reconciliation_required"].includes(
        String(existing.status),
      );
      if (!terminal) existing.status = "running";
      // The MARKER decides whether this is reconciliation-only, not the
      // status. A row sitting at `running` because a previous worker
      // claimed it and died before spending its unit has nothing to
      // reconcile — nothing was ever sent — and the member is still
      // owed its first attempt.
      const inFlight =
        existing.provider_in_flight_at !== null &&
        existing.provider_in_flight_at !== undefined;
      return {
        data: [
          {
            action_id: existing.id,
            may_mutate: !terminal && !inFlight,
            needs_reconcile: !terminal && inFlight,
            terminal,
            existing_status: existing.status,
          },
        ],
        error: null,
      };
    }

    const row: Row = {
      id: this.nextId("action"),
      workspace_id: args.p_workspace_id,
      operator_account_id: args.p_operator_account_id,
      candidate_id: null,
      batch_id: null,
      action_type: "follow",
      subject_did: args.p_subject_did,
      subject_handle_at_action: args.p_subject_handle,
      actor_did: args.p_actor_did,
      actor_handle_at_action: args.p_actor_handle,
      status: "running",
      source_target_profile_ids: [],
      initiated_by: args.p_initiated_by,
      initiator_kind: "operator_batch",
      campaign_id: args.p_campaign_id,
      campaign_run_id: args.p_run_id,
      campaign_member_id: args.p_member_id,
      // NOT in flight. Creating the audit row says "this worker intends
      // to handle this member", not "a request is in flight" — and
      // conflating the two silenced members that were never touched.
      // The marker goes up in `consume`, one statement before the call.
      provider_in_flight_at: null,
      started_at: new Date(this.nowMs()).toISOString(),
      requested_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    rows.push(row);
    return {
      data: [
        {
          action_id: row.id,
          may_mutate: true,
          needs_reconcile: false,
          terminal: false,
          existing_status: null,
        },
      ],
      error: null,
    };
  }

  /**
   * Mirrors 20260915000001's `resume_bluesky_campaign_run_after_recovery`.
   * Only a paused/failed/elapsed-rate-limited run moves. The unfollow
   * and incident regression suites exercise the REAL function against
   * PGlite; this exists so the FakeDb-based follow suites keep running.
   */
  private stopCampaignsForIdentity(args: Record<string, unknown>): QueryResult {
    let campaigns = 0;
    let runs = 0;
    for (const c of this.rows("bluesky_follow_campaigns")) {
      if (
        c.workspace_id !== args.p_workspace_id ||
        c.operator_account_id !== args.p_account_id ||
        c.status !== "active"
      ) continue;
      c.status = "reauthorization_required";
      c.last_error_code = "reauthorization_required";
      c.last_error_message = args.p_message ?? null;
      campaigns += 1;
      for (const r of this.rows("bluesky_follow_campaign_runs")) {
        if (r.campaign_id === c.id && r.status === "running") {
          r.status = "waiting_for_auth";
          r.last_error_code = "reauthorization_required";
          r.last_error_message = args.p_message ?? null;
          runs += 1;
        }
      }
    }
    return { data: [{ campaigns_stopped: campaigns, runs_stopped: runs }], error: null };
  }

  private resumeRunAfterRecovery(args: Record<string, unknown>): QueryResult {
    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) =>
        r.campaign_id === args.p_campaign_id &&
        r.workspace_id === args.p_workspace_id &&
        r.local_date === args.p_local_date,
    );
    if (!run) {
      return { data: [{ resumed: false, run_id: null, run_status: null }], error: null };
    }
    const until = run.rate_limited_until as string | null;
    let resumed = false;
    if (
      ["paused", "failed", "rate_limited"].includes(String(run.status)) &&
      (!until || new Date(until).getTime() <= this.nowMs())
    ) {
      run.status = "running";
      run.rate_limited_until = null;
      run.last_error_code = null;
      run.last_error_message = null;
      resumed = true;
    }
    return {
      data: [{ resumed, run_id: run.id, run_status: run.status }],
      error: null,
    };
  }

  /** Mirrors `reopen_bluesky_campaign_action`, including its closed code set. */
  private reopenAction(args: Record<string, unknown>): QueryResult {
    const DEFINITE = new Set([
      "ExpiredToken", "InvalidToken", "AuthMissing", "AuthenticationRequired",
      "session_expired", "RateLimitExceeded", "rate_limited",
      "provider_rejected_before_write",
    ]);
    const action = this.rows("bluesky_relationship_actions").find(
      (a) => a.id === args.p_action_id && a.workspace_id === args.p_workspace_id,
    );
    const refuse = (reason: string) => ({
      data: [{ reopened: false, refused_reason: reason }],
      error: null,
    });
    if (!action) return refuse("unknown_action");
    if (action.campaign_member_id !== args.p_member_id) return refuse("member_mismatch");
    if (["succeeded", "failed", "skipped"].includes(String(action.status))) {
      return refuse("action_terminal");
    }
    const code = args.p_error_code as string | null;
    if (!code || !DEFINITE.has(code)) return refuse("not_a_definite_rejection");
    action.status = "pending";
    action.provider_in_flight_at = null;
    action.finished_at = null;
    action.provider_error_code = code;
    action.provider_error_message = (args.p_error_message as string | null) ?? null;
    return { data: [{ reopened: true, refused_reason: null }], error: null };
  }

  /** Mirrors `defer_bluesky_campaign_member`: a duration, applied in the DB's clock. */
  private deferMember(args: Record<string, unknown>): QueryResult {
    const m = this.rows("bluesky_follow_campaign_members").find(
      (r) => r.id === args.p_member_id && r.workspace_id === args.p_workspace_id,
    );
    if (!m || m.status !== "retryable") return { data: null, error: null };
    const secs = Math.max(1, Number(args.p_delay_seconds ?? 60));
    m.next_attempt_at = new Date(this.nowMs() + secs * 1000).toISOString();
    return { data: m.next_attempt_at, error: null };
  }

  /** Mirrors `bluesky_campaign_may_complete`. */
  private mayComplete(args: Record<string, unknown>): QueryResult {
    const members = this.rows("bluesky_follow_campaign_members").filter(
      (m) => m.campaign_id === args.p_campaign_id && m.workspace_id === args.p_workspace_id,
    );
    const actionable = members.filter((m) =>
      ["queued", "claimed", "running", "provider_in_flight", "retryable"].includes(
        String(m.status),
      ),
    ).length;
    const openLeases = members.filter(
      (m) =>
        m.lease_expires_at &&
        new Date(String(m.lease_expires_at)).getTime() >= this.nowMs() &&
        ["claimed", "running", "provider_in_flight"].includes(String(m.status)),
    ).length;
    const openReservations = this.rows("bluesky_campaign_quota_reservations").filter(
      (r) =>
        r.campaign_id === args.p_campaign_id &&
        ["open", "held"].includes(String(r.status)),
    ).length;
    const actions = this.rows("bluesky_relationship_actions").filter(
      (a) => a.campaign_id === args.p_campaign_id,
    );
    const intents = actions.filter((a) => a.provider_in_flight_at).length;
    const unresolved = actions.filter((a) =>
      ["pending", "running", "reconciliation_required"].includes(String(a.status)),
    ).length;
    return {
      data:
        actionable === 0 &&
        openLeases === 0 &&
        openReservations === 0 &&
        intents === 0 &&
        unresolved === 0,
      error: null,
    };
  }

  private resumeRun(args: Record<string, unknown>): QueryResult {
    const run = this.rows("bluesky_follow_campaign_runs").find(
      (r) => r.id === args.p_run_id && r.workspace_id === args.p_workspace_id,
    );
    if (!run) return { data: null, error: null };
    const until = run.rate_limited_until as string | null;
    // Only a rate-limited run whose reset has passed. An operator pause
    // is never undone here.
    if (
      run.status === "rate_limited" &&
      (!until || new Date(until).getTime() <= this.nowMs())
    ) {
      run.status = "running";
      run.rate_limited_until = null;
      run.last_error_code = null;
      run.last_error_message = null;
    }
    return { data: run, error: null };
  }

  private recordIdentityUsage(args: Record<string, unknown>): QueryResult {
    const rows = this.rows("bluesky_identity_daily_usage");
    const existing = rows.find(
      (r) =>
        r.workspace_id === args.p_workspace_id &&
        r.operator_account_id === args.p_operator_account_id &&
        r.usage_date === args.p_usage_date,
    );
    const follows = Math.max(Number(args.p_follows_created ?? 0), 0);
    const attempts = Math.max(Number(args.p_attempts_made ?? 0), 0);
    if (existing) {
      // An increment, not a read-modify-write: two campaigns sharing an
      // identity must not lose each other's consumption.
      existing.follows_created = Number(existing.follows_created) + follows;
      existing.attempts_made = Number(existing.attempts_made) + attempts;
      return { data: existing, error: null };
    }
    const row: Row = {
      id: this.nextId("usage"),
      workspace_id: args.p_workspace_id,
      operator_account_id: args.p_operator_account_id,
      usage_date: args.p_usage_date,
      follows_created: follows,
      attempts_made: attempts,
      reserved_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    rows.push(row);
    return { data: row, error: null };
  }

  /** Natural-key columns, mirroring the real unique indexes. */
  private uniqueKey(table: string): string[] | null {
    switch (table) {
      case "bluesky_candidates":
      case "bluesky_target_profiles":
        return ["workspace_id", "operator_account_id", "subject_did"];
      case "bluesky_candidate_sources":
        return ["candidate_id", "target_profile_id"];
      case "bluesky_follow_campaign_members":
        return ["campaign_id", "subject_did"];
      case "bluesky_campaign_member_sources":
        return ["member_id", "target_profile_id", "source_label"];
      case "bluesky_follow_campaign_runs":
        return ["campaign_id", "local_date"];
      case "bluesky_identity_daily_usage":
        return ["workspace_id", "operator_account_id", "usage_date"];
      // One workspace-global row and one row per identity. In Postgres
      // this is a TOTAL unique index over a generated `identity_key`
      // column (the operator id, or the nil UUID for the global row);
      // here the null operator id collapses to the same sentinel, which
      // gives the global switch one stable slot instead of a new row on
      // every engage.
      case "bluesky_campaign_kill_switches":
        return ["workspace_id", "operator_account_id"];
      default:
        return null;
    }
  }

  private naturalKeyOf(table: string, row: Row): string | null {
    const key = this.uniqueKey(table);
    if (!key) return null;
    return key.map((column) => String(row[column] ?? "\u0000")).join("\u0001");
  }

  private indexFor(table: string): Map<string, Row> {
    let index = this.naturalKeyIndex.get(table);
    if (!index) {
      index = new Map();
      // Build lazily from whatever the test seeded directly.
      for (const row of this.rows(table)) {
        const key = this.naturalKeyOf(table, row);
        if (key !== null) index.set(key, row);
      }
      this.naturalKeyIndex.set(table, index);
    }
    return index;
  }

  findByNaturalKey(table: string, row: Row): Row | undefined {
    const key = this.naturalKeyOf(table, row);
    if (key === null) return undefined;
    return this.indexFor(table).get(key);
  }

  /** Record a newly-inserted row in the natural-key index. */
  indexRow(table: string, row: Row): void {
    const key = this.naturalKeyOf(table, row);
    if (key === null) return;
    this.indexFor(table).set(key, row);
  }

  /**
   * The database-level guards, reproduced. Returns a Postgres-shaped
   * error when the write would be refused.
   */
  checkConstraints(
    table: string,
    row: Row,
    operation: "insert" | "update",
  ): PostgresError | null {
    if (table === "bluesky_relationship_actions") {
      const active = row.status === "pending" || row.status === "running";
      if (active) {
        const clash = this.rows(table).find(
          (existing) =>
            existing.id !== row.id &&
            existing.workspace_id === row.workspace_id &&
            existing.operator_account_id === row.operator_account_id &&
            existing.subject_did === row.subject_did &&
            existing.action_type === row.action_type &&
            (existing.status === "pending" || existing.status === "running"),
        );
        if (clash) {
          return pgError(
            UNIQUE_VIOLATION,
            'duplicate key value violates unique constraint "bluesky_relationship_actions_one_active"',
          );
        }
      }

      if (operation === "insert" && row.batch_id) {
        const batch = this.rows("bluesky_action_batches").find(
          (b) => b.id === row.batch_id,
        );
        if (batch && batch.confirmed_at) {
          return pgError(
            CHECK_VIOLATION,
            `bluesky batch ${String(row.batch_id)} is confirmed; its membership is immutable`,
          );
        }
      }
    }

    if (table === "bluesky_import_runs") {
      if (row.status === "completed" && row.cursor_exhausted !== true) {
        return pgError(
          CHECK_VIOLATION,
          'new row violates check constraint "bluesky_import_runs_completion_requires_exhaustion"',
        );
      }
    }

    return null;
  }
}

type QueryResult = {
  data: unknown;
  error: PostgresError | null;
  /** Present when the caller asked for `count`. */
  count?: number;
};

class FakeQuery implements PromiseLike<QueryResult> {
  private filters: Filter[] = [];
  private operation: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: Row[] = [];
  private singleRow = false;
  private maybe = false;
  private limitValue: number | null = null;
  private orderKeys: { column: string; ascending: boolean }[] = [];
  private wantCount = false;
  private headOnly = false;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private ignoreDuplicates = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(
    _columns?: string,
    options?: { count?: "exact" | "planned" | "estimated"; head?: boolean },
  ): this {
    // `head: true` means "count only, transfer no rows" — the shape the
    // repository uses for exact totals. Reproduced faithfully so a test
    // asserting a count is exercising the same code path production
    // takes, not a convenient shortcut.
    this.wantCount = options?.count !== undefined;
    this.headOnly = options?.head === true;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  insert(values: Row | Row[]): this {
    this.operation = "insert";
    this.payload = Array.isArray(values) ? values : [values];
    return this;
  }
  upsert(
    values: Row | Row[],
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this.operation = "upsert";
    this.payload = Array.isArray(values) ? values : [values];
    // PostgREST returns only the rows it actually INSERTED when
    // ignoreDuplicates is set, which is how the importer counts
    // inserted-vs-duplicate without a second query.
    this.ignoreDuplicates = options?.ignoreDuplicates === true;
    return this;
  }
  update(values: Row): this {
    this.operation = "update";
    this.payload = [values];
    return this;
  }
  delete(): this {
    this.operation = "delete";
    return this;
  }
  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: "in", column, value: values });
    return this;
  }
  is(column: string, value: unknown): this {
    this.filters.push({ kind: "is", column, value });
    return this;
  }
  or(expression: string): this {
    this.filters.push({ kind: "or", column: "", value: expression });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    // Multiple .order() calls compose, as in PostgREST. The second key
    // is what makes paging stable when the first key ties.
    this.orderKeys.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(n: number): this {
    this.limitValue = n;
    return this;
  }
  maybeSingle(): this {
    this.maybe = true;
    return this;
  }
  single(): PromiseLike<QueryResult> {
    this.singleRow = true;
    return Promise.resolve(this.run());
  }
  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  /**
   * Read a column the way PostgreSQL would.
   *
   * A NOT NULL column with a DEFAULT is never absent from a real row:
   * an INSERT that omits it stores the default. Tests here seed rows as
   * object literals and omit whatever a migration added most recently,
   * so a filter on that column matched nothing and every affected test
   * failed at once — with a message about the campaign not being found
   * rather than about the missing field.
   *
   * Falling back to the declared default makes the fake behave the way
   * the database does, once, instead of requiring every seed in the
   * repository to be revisited each time a column is added.
   */
  private column(row: Row, name: string): unknown {
    const value = row[name];
    if (value !== undefined) return value;
    const fallback = defaultsFor(this.table)[name];
    return fallback === undefined ? undefined : fallback;
  }

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      switch (filter.kind) {
        case "eq":
          return this.column(row, filter.column) === filter.value;
        case "is":
          return filter.value === null
            ? row[filter.column] === null || row[filter.column] === undefined
            : row[filter.column] === filter.value;
        case "in":
          return (filter.value as unknown[]).includes(
            this.column(row, filter.column),
          );
        case "or": {
          // PostgREST `or=(a.op.v,b.op.v)`. Only the operators the
          // repositories actually emit are supported — an unrecognised
          // one throws rather than silently evaluating false, because a
          // filter that quietly matches nothing is how a test comes to
          // assert the wrong behaviour.
          const clauses = String(filter.value).split(",");
          return clauses.some((clause) => {
            const [column, op, ...rest] = clause.split(".");
            const operand = rest.join(".");
            const value = row[column];
            switch (op) {
              case "ilike": {
                const term = operand.replace(/%/g, "").toLowerCase();
                return (
                  typeof value === "string" && value.toLowerCase().includes(term)
                );
              }
              case "is":
                return operand === "null"
                  ? value === null || value === undefined
                  : String(value) === operand;
              case "eq":
                return String(value) === operand;
              case "lte":
                return value !== null && value !== undefined
                  ? String(value) <= operand
                  : false;
              case "gte":
                return value !== null && value !== undefined
                  ? String(value) >= operand
                  : false;
              default:
                throw new Error(
                  `fake-db: unsupported or() operator "${op}" in "${clause}"`,
                );
            }
          });
        }
      }
    });
  }

  private run(): QueryResult {
    const rows = this.db.rows(this.table);

    if (this.operation === "insert" || this.operation === "upsert") {
      const written: Row[] = [];
      for (const values of this.payload) {
        const existing =
          this.operation === "upsert"
            ? this.db.findByNaturalKey(this.table, values)
            : undefined;

        if (existing) {
          if (this.ignoreDuplicates) {
            // ON CONFLICT DO NOTHING: the existing row is untouched and
            // is NOT returned. A member already in a campaign therefore
            // keeps its import_sequence and its progress across a
            // re-import of an overlapping audience.
            continue;
          }
          // Conflict-update. Columns absent from the payload are left
          // alone — which is what preserves first_discovered_at and the
          // follow-record identity across a re-import.
          const merged = {
            ...existing,
            ...values,
            updated_at: new Date().toISOString(),
          };
          const violation = this.db.checkConstraints(this.table, merged, "update");
          if (violation) return { data: null, error: violation };
          Object.assign(existing, merged);
          written.push(existing);
          continue;
        }

        const row: Row = {
          id: values.id ?? this.db.nextId(this.table),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...defaultsFor(this.table),
          ...values,
        };
        const violation = this.db.checkConstraints(this.table, row, "insert");
        if (violation) return { data: null, error: violation };
        rows.push(row);
        this.db.indexRow(this.table, row);
        written.push(row);
      }
      return this.shape(written);
    }

    if (this.operation === "update") {
      const target = rows.filter((row) => this.matches(row));
      const written: Row[] = [];
      for (const row of target) {
        const merged = {
          ...row,
          ...this.payload[0],
          updated_at: new Date().toISOString(),
        };
        const violation = this.db.checkConstraints(this.table, merged, "update");
        if (violation) return { data: null, error: violation };
        Object.assign(row, merged);
        written.push(row);
      }
      return this.shape(written);
    }

    if (this.operation === "delete") {
      const removed = rows.filter((row) => this.matches(row));
      this.db.tables.set(
        this.table,
        rows.filter((row) => !this.matches(row)),
      );
      return this.shape(removed);
    }

    let result = rows.filter((row) => this.matches(row));

    if (this.orderKeys.length > 0) {
      result = [...result].sort((a, b) => {
        for (const key of this.orderKeys) {
          const cmp = compareValues(a[key.column], b[key.column]);
          if (cmp !== 0) return key.ascending ? cmp : -cmp;
        }
        return 0;
      });
    }

    // The exact total is taken BEFORE range/limit, which is the whole
    // point of an exact count: it describes the filtered set, not the
    // slice returned.
    const total = result.length;

    if (this.rangeFrom !== null && this.rangeTo !== null) {
      result = result.slice(this.rangeFrom, this.rangeTo + 1);
    }
    if (this.limitValue !== null) result = result.slice(0, this.limitValue);

    if (this.headOnly) return { data: null, error: null, count: total };
    return { ...this.shape(result), ...(this.wantCount ? { count: total } : {}) };
  }

  private shape(rows: Row[]): QueryResult {
    const copies = rows.map((r) => ({ ...r }));
    if (this.singleRow) {
      if (copies.length !== 1) {
        return {
          data: null,
          error: pgError(
            "PGRST116",
            "JSON object requested, multiple (or no) rows returned",
          ),
        };
      }
      return { data: copies[0], error: null };
    }
    if (this.maybe) return { data: copies[0] ?? null, error: null };
    return { data: copies, error: null };
  }
}

/**
 * Order two column values the way Postgres would.
 *
 * Type-aware, because the first version compared everything as a
 * string: `import_sequence` is a BIGINT, so a lexicographic sort put
 * 17,017 before 1,702 and the pagination tests were exercising an
 * ordering the real database never produces. A fake that sorts
 * differently from Postgres does not merely fail to catch a bug — it
 * asserts the wrong behaviour is correct.
 */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b));
}

/** Column defaults the real schema applies. */
function defaultsFor(table: string): Row {
  switch (table) {
    case "bluesky_candidates":
      return {
        relationship_state: "unknown",
        relationship_checked_at: null,
        relationship_error: null,
        followed_at: null,
        unfollowed_at: null,
        follow_uri: null,
        follow_rkey: null,
        follow_cid: null,
        follow_record_source: null,
        protected: false,
        protected_at: null,
        protected_by: null,
        first_discovered_at: new Date().toISOString(),
        last_discovered_at: new Date().toISOString(),
      };
    case "bluesky_import_runs":
      return {
        status: "pending",
        cursor: null,
        cursor_exhausted: false,
        pages_fetched: 0,
        followers_seen: 0,
        candidates_created: 0,
        candidates_updated: 0,
        stop_reason: null,
        last_error: null,
        started_at: null,
        finished_at: null,
      };
    case "bluesky_action_batches":
      return {
        status: "pending",
        requested_count: 0,
        processed_count: 0,
        succeeded_count: 0,
        failed_count: 0,
        reconciliation_required_count: 0,
        stop_reason: null,
        last_error: null,
        confirmed_at: null,
        confirmed_by: null,
        started_at: null,
        finished_at: null,
      };
    case "bluesky_relationship_actions":
      return {
        status: "pending",
        follow_uri: null,
        follow_rkey: null,
        follow_cid: null,
        provider_status_code: null,
        provider_error_code: null,
        provider_error_message: null,
        reconciled_state: null,
        reconciled_at: null,
        reconciliation_note: null,
        source_target_profile_ids: [],
        initiator_kind: "operator_single",
        requested_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
      };
    case "bluesky_candidate_sources":
      return {
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        times_seen: 1,
      };
    case "bluesky_follow_campaign_runs":
      return {
        status: "running",
        attempted_count: 0,
        succeeded_count: 0,
        already_following_count: 0,
        skipped_count: 0,
        failed_count: 0,
        consecutive_failures: 0,
        reserved_count: 0,
        rate_limited_until: null,
        rate_limit_remaining: null,
        rate_limit_reset_at: null,
      };
    case "bluesky_follow_campaign_members":
      return {
        status: "queued",
        attempt_count: 0,
        next_attempt_at: null,
        claimed_at: null,
        claimed_by: null,
        lease_expires_at: null,
        provider_record_uri: null,
        provider_record_rkey: null,
        provider_record_cid: null,
        last_error_code: null,
        last_error_message: null,
        last_attempted_at: null,
        completed_at: null,
        current_handle: null,
        display_name: null,
      };
    case "bluesky_follow_campaigns":
      return {
        // Mirrors the column default added by
        // 20260914000001_bluesky_unfollow_campaigns. The dispatcher
        // filters on it, so a row without one is invisible to the
        // dispatcher that is meant to run it — which is exactly the
        // drift this fake is prone to, and the reason the unfollow
        // suites run against the real migration instead.
        kind: "follow",
        status: "draft",
        requested_daily_quota: 100,
        timezone: "UTC",
        execution_window_start_minute: 540,
        execution_window_end_minute: 1200,
        start_date: null,
        dry_run: false,
        max_consecutive_failures: 5,
        min_success_rate_percent: 50,
        next_run_at: null,
        activated_at: null,
        completed_at: null,
        paused_at: null,
        cancelled_at: null,
        last_error_code: null,
        last_error_message: null,
        rate_limited_until: null,
      };
    case "bluesky_campaign_member_sources":
      return {
        source_label: "import",
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        times_seen: 1,
      };
    default:
      return {};
  }
}
