/**
 * A Supabase client backed by a REAL PostgreSQL.
 *
 * WHY THIS EXISTS
 * ---------------
 * The follow subsystem's worker tests run against `FakeDb`, a 2,100-line
 * TypeScript reimplementation of the campaign RPCs. That was the right
 * call when it was written — there was no local Postgres — but it has a
 * failure mode that matters a great deal for a DELETE path:
 *
 *   **a test cannot catch a bug in a predicate it shares with the code
 *   under test.**
 *
 * If the fake's `claim_bluesky_unfollow_action` and the migration's
 * disagree, the tests prove the fake correct and say nothing about what
 * deploys. For a subsystem whose mistakes are irreversible and visible
 * to strangers, that is not a trade worth making.
 *
 * So the unfollow tests run the REAL migrations against PGlite (genuine
 * PostgreSQL) and reach them through this adapter, which translates the
 * subset of the PostgREST builder the code actually uses into SQL.
 *
 * WHAT IT IS AND IS NOT
 * ---------------------
 * It is a faithful path to real SQL: real constraints, real triggers,
 * real plpgsql, real `FOR UPDATE SKIP LOCKED` planner nodes.
 *
 * It is NOT a proof of multi-session behaviour. PGlite runs a single
 * backend, so two genuinely simultaneous sessions do not exist. Every
 * claim about locking, contention or deadlock is made in
 * `*.two-session.pg.test.ts`, against `embedded-postgres`, which is an
 * ordinary server with one backend per connection.
 *
 * It is also NOT a PostgREST emulator. It supports exactly the
 * operations this code path uses and throws loudly on anything else,
 * because a silently-ignored filter would make a test pass by reading
 * rows it should never have seen.
 */

/**
 * The one thing the adapter needs from a database: `query`. PGlite and
 * `pg` (Client or Pool) both answer with the same `{ rows }` shape, so
 * the same adapter serves the single-backend WASM suites and the
 * embedded-server scale regression.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
import type { SupabaseClient } from "@supabase/supabase-js";

type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "neq"; column: string; value: unknown }
  | { op: "in"; column: string; values: unknown[] }
  | { op: "is"; column: string; value: null }
  | { op: "gte" | "lte" | "gt" | "lt"; column: string; value: unknown }
  | { op: "or"; raw: string };

interface Result<T> {
  data: T;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

const ident = (name: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`refusing unsafe identifier: ${name}`);
  }
  return `"${name}"`;
};

/**
 * Translate one PostgREST `or(...)` string.
 *
 * Only the forms this code actually emits are accepted —
 * `col.is.null` and `col.lte.<value>` — and anything else throws. A
 * permissive parser here would quietly widen a filter, and the one
 * place `or` is used is the dispatcher's "which campaigns are due",
 * where widening means running a campaign before its time.
 */
function compileOr(raw: string, params: unknown[]): string {
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const clauses = parts.map((part) => {
    const [column, op, ...rest] = part.split(".");
    const value = rest.join(".");
    switch (op) {
      case "is":
        if (value !== "null") throw new Error(`unsupported or(): ${part}`);
        return `${ident(column)} is null`;
      case "lte":
        params.push(value);
        return `${ident(column)} <= $${params.length}`;
      case "gte":
        params.push(value);
        return `${ident(column)} >= $${params.length}`;
      case "eq":
        params.push(value);
        return `${ident(column)} = $${params.length}`;
      default:
        throw new Error(`unsupported or() operator: ${part}`);
    }
  });
  return `(${clauses.join(" or ")})`;
}

function compileFilters(filters: Filter[], params: unknown[]): string {
  if (filters.length === 0) return "";
  const clauses = filters.map((f) => {
    switch (f.op) {
      case "eq":
        params.push(f.value);
        return `${ident(f.column)} = $${params.length}`;
      case "neq":
        params.push(f.value);
        return `${ident(f.column)} <> $${params.length}`;
      case "is":
        return `${ident(f.column)} is null`;
      case "in": {
        if (f.values.length === 0) return "false";
        const slots = f.values.map((v) => {
          params.push(v);
          return `$${params.length}`;
        });
        return `${ident(f.column)} in (${slots.join(", ")})`;
      }
      case "gte":
      case "lte":
      case "gt":
      case "lt": {
        params.push(f.value);
        const sym = { gte: ">=", lte: "<=", gt: ">", lt: "<" }[f.op];
        return `${ident(f.column)} ${sym} $${params.length}`;
      }
      case "or":
        return compileOr(f.raw, params);
    }
  });
  return ` where ${clauses.join(" and ")}`;
}

class Builder<T = Record<string, unknown>[]> implements PromiseLike<Result<T>> {
  private filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean }[] = [];
  private limitTo: number | null = null;
  private selectCols = "*";
  private wantCount = false;
  private headOnly = false;
  private single_: "one" | "maybe" | null = null;
  private mode:
    | { kind: "select" }
    | { kind: "update"; patch: Record<string, unknown> }
    | { kind: "insert"; rows: Record<string, unknown>[] }
    | {
        kind: "upsert";
        rows: Record<string, unknown>[];
        onConflict: string | null;
      }
    | { kind: "delete" } = { kind: "select" };
  private returning = false;

  constructor(
    private db: Queryable,
    private table: string,
  ) {}

  select(
    cols = "*",
    opts?: { count?: "exact"; head?: boolean },
  ): Builder<T> {
    if (this.mode.kind === "select") {
      this.selectCols = cols;
    } else {
      // `.update(...).eq(...).select("*")` — PostgREST's RETURNING.
      this.returning = true;
      this.selectCols = cols;
    }
    if (opts?.count === "exact") this.wantCount = true;
    if (opts?.head) this.headOnly = true;
    return this;
  }

  update(patch: Record<string, unknown>): Builder<T> {
    this.mode = { kind: "update", patch };
    return this;
  }

  insert(rows: Record<string, unknown> | Record<string, unknown>[]): Builder<T> {
    this.mode = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] };
    return this;
  }

  upsert(
    rows: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): Builder<T> {
    this.mode = {
      kind: "upsert",
      rows: Array.isArray(rows) ? rows : [rows],
      onConflict: opts?.onConflict ?? null,
    };
    return this;
  }

  delete(): Builder<T> {
    this.mode = { kind: "delete" };
    return this;
  }

  eq(column: string, value: unknown): Builder<T> {
    this.filters.push({ op: "eq", column, value });
    return this;
  }
  neq(column: string, value: unknown): Builder<T> {
    this.filters.push({ op: "neq", column, value });
    return this;
  }
  in(column: string, values: unknown[]): Builder<T> {
    this.filters.push({ op: "in", column, values });
    return this;
  }
  is(column: string, value: null): Builder<T> {
    this.filters.push({ op: "is", column, value });
    return this;
  }
  gte(column: string, value: unknown): Builder<T> {
    this.filters.push({ op: "gte", column, value });
    return this;
  }
  lte(column: string, value: unknown): Builder<T> {
    this.filters.push({ op: "lte", column, value });
    return this;
  }
  or(raw: string): Builder<T> {
    this.filters.push({ op: "or", raw });
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }): Builder<T> {
    this.orderBy.push({ column, ascending: opts?.ascending !== false });
    return this;
  }
  limit(n: number): Builder<T> {
    this.limitTo = n;
    return this;
  }
  range(from: number, to: number): Builder<T> {
    // PostgREST's range is inclusive. Supported because the UI paging
    // helpers use it; the worker path never does.
    this.rangeFrom = from;
    this.limitTo = to - from + 1;
    return this;
  }
  private rangeFrom = 0;

  maybeSingle(): Builder<Record<string, unknown> | null> {
    this.single_ = "maybe";
    return this as unknown as Builder<Record<string, unknown> | null>;
  }
  single(): Builder<Record<string, unknown>> {
    this.single_ = "one";
    return this as unknown as Builder<Record<string, unknown>>;
  }

  async run(): Promise<Result<T>> {
    const params: unknown[] = [];
    let sql: string;

    try {
      switch (this.mode.kind) {
        case "select": {
          if (this.headOnly && this.wantCount) {
            sql =
              `select count(*)::int as c from public.${ident(this.table)}` +
              compileFilters(this.filters, params);
            const r = await this.db.query<{ c: number }>(sql, params);
            return {
              data: null as unknown as T,
              error: null,
              count: Number(r.rows[0]?.c ?? 0),
            };
          }
          sql =
            `select ${this.columns()} from public.${ident(this.table)}` +
            compileFilters(this.filters, params) +
            this.orderClause() +
            this.limitClause();
          const r = await this.db.query<Record<string, unknown>>(sql, params);
          return this.finish(r.rows);
        }

        case "update": {
          const sets = Object.keys(this.mode.patch).map((k) => {
            params.push((this.mode as { patch: Record<string, unknown> }).patch[k]);
            return `${ident(k)} = $${params.length}`;
          });
          if (sets.length === 0) return { data: [] as unknown as T, error: null };
          sql =
            `update public.${ident(this.table)} set ${sets.join(", ")}` +
            compileFilters(this.filters, params) +
            (this.returning ? ` returning ${this.columns()}` : "");
          const r = await this.db.query<Record<string, unknown>>(sql, params);
          return this.finish(this.returning ? r.rows : []);
        }

        case "insert":
        case "upsert": {
          const rows = this.mode.rows;
          if (rows.length === 0) return { data: [] as unknown as T, error: null };
          const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
          const tuples = rows.map(
            (row) =>
              `(${cols
                .map((c) => {
                  params.push(row[c] ?? null);
                  return `$${params.length}`;
                })
                .join(", ")})`,
          );
          const conflict =
            this.mode.kind === "upsert" && this.mode.onConflict
              ? ` on conflict (${this.mode.onConflict
                  .split(",")
                  .map((c) => ident(c.trim()))
                  .join(", ")}) do update set ${cols
                  .map((c) => `${ident(c)} = excluded.${ident(c)}`)
                  .join(", ")}`
              : "";
          sql =
            `insert into public.${ident(this.table)} ` +
            `(${cols.map(ident).join(", ")}) values ${tuples.join(", ")}` +
            conflict +
            (this.returning ? ` returning ${this.columns()}` : "");
          const r = await this.db.query<Record<string, unknown>>(sql, params);
          return this.finish(this.returning ? r.rows : []);
        }

        case "delete": {
          sql =
            `delete from public.${ident(this.table)}` +
            compileFilters(this.filters, params) +
            (this.returning ? ` returning ${this.columns()}` : "");
          const r = await this.db.query<Record<string, unknown>>(sql, params);
          return this.finish(this.returning ? r.rows : []);
        }
      }
    } catch (err) {
      // Shaped like a PostgREST error so `fromPostgres` behaves exactly
      // as it does in production.
      return {
        data: null as unknown as T,
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: "P0001",
        },
      };
    }
  }

  private columns(): string {
    if (this.selectCols === "*") return "*";
    return this.selectCols
      .split(",")
      .map((c) => ident(c.trim()))
      .join(", ");
  }

  private orderClause(): string {
    if (this.orderBy.length === 0) return "";
    return (
      " order by " +
      this.orderBy
        .map((o) => `${ident(o.column)} ${o.ascending ? "asc" : "desc"}`)
        .join(", ")
    );
  }

  private limitClause(): string {
    let clause = "";
    if (this.limitTo !== null) clause += ` limit ${Number(this.limitTo)}`;
    if (this.rangeFrom > 0) clause += ` offset ${Number(this.rangeFrom)}`;
    return clause;
  }

  private finish(rows: Record<string, unknown>[]): Result<T> {
    if (this.single_ === "maybe") {
      return { data: (rows[0] ?? null) as unknown as T, error: null };
    }
    if (this.single_ === "one") {
      if (rows.length !== 1) {
        return {
          data: null as unknown as T,
          error: { message: "expected exactly one row", code: "PGRST116" },
        };
      }
      return { data: rows[0] as unknown as T, error: null };
    }
    return { data: rows as unknown as T, error: null, count: rows.length };
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/**
 * Build a Supabase-shaped client over a real PGlite database.
 *
 * RPCs are called with NAMED notation (`fn(p_a := $1)`), so a parameter
 * added to a function in a later migration cannot silently shift the
 * meaning of an existing call site — which positional notation would
 * allow and which is exactly the kind of mistake that ends with a
 * delete aimed at the wrong argument.
 */
export function pgliteSupabase(db: Queryable): SupabaseClient {
  const api = {
    from: (table: string) => new Builder(db, table),
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const names = Object.keys(args);
      const params = names.map((n) => args[n]);
      const call = names.length
        ? names.map((n, i) => `${ident(n)} := $${i + 1}`).join(", ")
        : "";
      try {
        const r = await db.query<Record<string, unknown>>(
          `select * from public.${ident(fn)}(${call})`,
          params,
        );

        // SCALAR UNWRAPPING.
        //
        // PostgREST returns a scalar-returning function's value
        // directly — `true`, not `[{ acquire_…: true }]`. `select *
        // from f()` names the column after the function, so a scalar
        // result is detectable and must be unwrapped, or every caller
        // written as `data === true` silently reads false.
        //
        // This is not a cosmetic difference. The dispatch lease is
        // exactly such a call: without this, every dispatcher pass
        // concludes "another dispatcher holds this campaign" and the
        // whole subsystem does nothing while every test that only
        // counts provider calls still passes.
        const scalar =
          r.rows.length > 0 &&
          r.rows.every(
            (row) =>
              Object.keys(row).length === 1 &&
              Object.prototype.hasOwnProperty.call(row, fn),
          );
        if (scalar) {
          const values = r.rows.map((row) => row[fn]);
          return { data: values.length === 1 ? values[0] : values, error: null };
        }

        return { data: r.rows, error: null };
      } catch (err) {
        return {
          data: null,
          error: {
            message: err instanceof Error ? err.message : String(err),
            code: "P0001",
          },
        };
      }
    },
  };
  return api as unknown as SupabaseClient;
}
