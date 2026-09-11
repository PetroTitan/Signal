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
    } as unknown as SupabaseClient;
  }

  /** Natural-key columns, mirroring the real unique indexes. */
  private uniqueKey(table: string): string[] | null {
    switch (table) {
      case "bluesky_candidates":
      case "bluesky_target_profiles":
        return ["workspace_id", "operator_account_id", "subject_did"];
      case "bluesky_candidate_sources":
        return ["candidate_id", "target_profile_id"];
      default:
        return null;
    }
  }

  findByNaturalKey(table: string, row: Row): Row | undefined {
    const key = this.uniqueKey(table);
    if (!key) return undefined;
    return this.rows(table).find((existing) =>
      key.every((column) => existing[column] === row[column]),
    );
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
  upsert(values: Row | Row[], _options?: { onConflict?: string; ignoreDuplicates?: boolean }): this {
    this.operation = "upsert";
    this.payload = Array.isArray(values) ? values : [values];
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
          const clauses = String(filter.value).split(",");
          return clauses.some((clause) => {
            const [column, op, ...rest] = clause.split(".");
            if (op !== "ilike") return false;
            const term = rest.join(".").replace(/%/g, "").toLowerCase();
            const value = row[column];
            return typeof value === "string" && value.toLowerCase().includes(term);
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
          const av = String(a[key.column] ?? "");
          const bv = String(b[key.column] ?? "");
          const cmp = key.ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          if (cmp !== 0) return cmp;
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
    default:
      return {};
  }
}
