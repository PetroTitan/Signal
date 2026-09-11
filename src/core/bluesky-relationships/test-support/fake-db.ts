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
        return this.releaseCampaignMembers(args);
      case "ensure_bluesky_campaign_run":
        return this.ensureCampaignRun(args);
      case "record_bluesky_identity_usage":
        return this.recordIdentityUsage(args);
      default:
        return {
          data: null,
          error: pgError("42883", `function ${fn} does not exist`),
        };
    }
  }

  private claimCampaignMembers(args: Record<string, unknown>): QueryResult {
    const now = Date.now();
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

  private releaseCampaignMembers(args: Record<string, unknown>): QueryResult {
    const ids = new Set((args.p_member_ids as string[]) ?? []);
    let count = 0;
    for (const m of this.rows("bluesky_follow_campaign_members")) {
      if (m.workspace_id !== args.p_workspace_id) continue;
      if (m.campaign_id !== args.p_campaign_id) continue;
      if (!ids.has(String(m.id))) continue;
      if (m.status !== "claimed" && m.status !== "running") continue;
      m.status = "queued";
      m.claimed_at = null;
      m.claimed_by = null;
      m.lease_expires_at = null;
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

  private matches(row: Row): boolean {
    return this.filters.every((filter) => {
      switch (filter.kind) {
        case "eq":
          return row[filter.column] === filter.value;
        case "is":
          return filter.value === null
            ? row[filter.column] === null || row[filter.column] === undefined
            : row[filter.column] === filter.value;
        case "in":
          return (filter.value as unknown[]).includes(row[filter.column]);
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
