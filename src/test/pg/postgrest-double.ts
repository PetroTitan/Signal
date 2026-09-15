/**
 * A PostgREST double over REAL PostgreSQL — with Next's Data Cache.
 *
 * WHY THIS EXISTS
 * ---------------
 * The service-role client is `@supabase/supabase-js` speaking PostgREST
 * over `fetch`. In a Next.js route handler that `fetch` is Next's
 * patched one, and in a GET-only route handler that never sets
 * `revalidate = 0`, every request the client makes without
 * `cache: "no-store"` is keyed and stored in the persistent Data Cache
 * — across invocations. That is how a worker on 2026-09-15 read a token
 * generation that another invocation had already superseded, was told
 * to reload, and reloaded the same cached row.
 *
 * The PGlite adapter (`supabase-adapter.ts`) bypasses `fetch` entirely,
 * so it cannot see this class of defect. This double keeps the REAL
 * client and the REAL `fetch` call shape: it translates the PostgREST
 * subset the campaign subsystem uses into SQL on a real backend, and it
 * reproduces the Data Cache's decision — serve a stored response for
 * any request that did not opt out — so a test can prove a request was
 * or was not served from cache.
 *
 * Not a general PostgREST. Unsupported shapes throw loudly.
 */

import { createHash } from "node:crypto";
import type { Queryable } from "./supabase-adapter";

type Row = Record<string, unknown>;

export interface RequestRecord {
  method: string;
  /** Path plus query, minus the origin. Never contains a token. */
  path: string;
  table: string | null;
  cache: string | undefined;
  fromCache: boolean;
  status: number;
}

export interface PostgrestDouble {
  fetch: typeof fetch;
  stats: { requests: number; cacheHits: number; cacheStores: number; noStore: number };
  requests: RequestRecord[];
  clearCache(): void;
  clearLog(): void;
  clearStats(): void;
}

export interface PostgrestDoubleOptions {
  /**
   * Behave like Next 14's Data Cache in a GET route handler: any request
   * that did not say `cache: "no-store"` (or "no-cache") is keyed by
   * method + url + headers + body; a 200 is stored; a later identical
   * request is served from the store without touching the database.
   */
  dataCache?: boolean;
}

const IDENT = /^[a-z_][a-z0-9_]*$/i;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`postgrest-double: unsafe identifier "${name}"`);
  return `"${name}"`;
}

function serialize(value: unknown, oid: number | undefined): unknown {
  if (value instanceof Date) {
    return oid === 1082 ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  if (typeof value === "bigint") return Number(value);
  return value;
}

function rowsToJson(res: { rows: Row[]; fields?: { name: string; dataTypeID: number }[] }): Row[] {
  const oids = new Map((res.fields ?? []).map((f) => [f.name, f.dataTypeID]));
  return res.rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, serialize(v, oids.get(k))])),
  );
}

/** Split on commas that are not inside parentheses or double quotes. */
function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of list) {
    if (ch === '"') quoted = !quoted;
    if (!quoted) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

const unquote = (v: string) =>
  v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;

function compileCondition(column: string, expr: string, params: unknown[]): string {
  let negate = false;
  if (expr.startsWith("not.")) {
    negate = true;
    expr = expr.slice(4);
  }
  const dot = expr.indexOf(".");
  if (dot < 0) throw new Error(`postgrest-double: bad filter "${column}=${expr}"`);
  const op = expr.slice(0, dot);
  const raw = expr.slice(dot + 1);
  const col = ident(column);
  let sql: string;
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (op) {
    case "eq": sql = `${col} = ${bind(unquote(raw))}`; break;
    case "neq": sql = `${col} <> ${bind(unquote(raw))}`; break;
    case "gt": sql = `${col} > ${bind(unquote(raw))}`; break;
    case "gte": sql = `${col} >= ${bind(unquote(raw))}`; break;
    case "lt": sql = `${col} < ${bind(unquote(raw))}`; break;
    case "lte": sql = `${col} <= ${bind(unquote(raw))}`; break;
    case "like": sql = `${col} like ${bind(raw)}`; break;
    case "ilike": sql = `${col} ilike ${bind(raw)}`; break;
    case "is":
      if (raw === "null") sql = `${col} is null`;
      else if (raw === "not.null") sql = `${col} is not null`;
      else if (raw === "true") sql = `${col} is true`;
      else if (raw === "false") sql = `${col} is false`;
      else throw new Error(`postgrest-double: unsupported is.${raw}`);
      break;
    case "in": {
      const vals = splitTop(raw.slice(1, -1)).map(unquote).filter((v) => v.length > 0);
      sql = vals.length === 0 ? "false" : `${col} in (${vals.map(bind).join(",")})`;
      break;
    }
    default:
      throw new Error(`postgrest-double: unsupported operator "${op}"`);
  }
  return negate ? `not (${sql})` : sql;
}

function compileOr(group: string, params: unknown[]): string {
  if (!group.startsWith("(") || !group.endsWith(")")) {
    throw new Error(`postgrest-double: bad or=${group}`);
  }
  const parts = splitTop(group.slice(1, -1));
  return `(${parts
    .map((p) => {
      const dot = p.indexOf(".");
      return compileCondition(p.slice(0, dot), p.slice(dot + 1), params);
    })
    .join(" or ")})`;
}

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function compileWhere(url: URL, params: unknown[]): string {
  const conds: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (RESERVED.has(key)) continue;
    if (key === "or") conds.push(compileOr(value, params));
    else conds.push(compileCondition(key, value, params));
  }
  return conds.length ? ` where ${conds.join(" and ")}` : "";
}

function compileOrder(url: URL): string {
  const raw = url.searchParams.get("order");
  if (!raw) return "";
  const terms = raw.split(",").map((t) => {
    const [col, dir, nulls] = t.split(".");
    return `${ident(col)} ${dir === "desc" ? "desc" : "asc"}${
      nulls === "nullsfirst" ? " nulls first" : nulls === "nullslast" ? " nulls last" : ""
    }`;
  });
  return ` order by ${terms.join(", ")}`;
}

function compileColumns(url: URL): string {
  const raw = url.searchParams.get("select") ?? "*";
  return raw
    .split(",")
    .map((c) => c.trim())
    .map((c) => (c === "*" ? "*" : ident(c)))
    .join(", ");
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function pgError(err: unknown): Response {
  const e = err as { code?: string; message?: string; detail?: string; hint?: string };
  const code = e?.code ?? "P0001";
  return json(
    { code, message: e?.message ?? String(err), details: e?.detail ?? null, hint: e?.hint ?? null },
    code === "23505" ? 409 : 400,
  );
}

export function createPostgrestDouble(
  db: Queryable,
  opts: PostgrestDoubleOptions = {},
): PostgrestDouble {
  const store = new Map<string, { status: number; headers: Record<string, string>; body: string }>();
  const double: PostgrestDouble = {
    fetch: (async () => json({})) as typeof fetch,
    stats: { requests: 0, cacheHits: 0, cacheStores: 0, noStore: 0 },
    requests: [],
    clearCache: () => store.clear(),
    clearLog: () => {
      double.requests.length = 0;
    },
    clearStats: () => {
      double.stats.requests = 0;
      double.stats.cacheHits = 0;
      double.stats.cacheStores = 0;
      double.stats.noStore = 0;
    },
  };

  const run = async (sql: string, params: unknown[]) =>
    (await db.query(sql, params)) as { rows: Row[]; fields?: { name: string; dataTypeID: number }[] };

  async function execute(method: string, url: URL, headers: Headers, bodyText: string): Promise<Response> {
    const m = url.pathname.match(/^\/rest\/v1\/(rpc\/)?([a-z_][a-z0-9_]*)$/i);
    if (!m) throw new Error(`postgrest-double: unsupported path ${url.pathname}`);
    const isRpc = Boolean(m[1]);
    const name = m[2];
    const prefer = headers.get("prefer") ?? "";
    const accept = headers.get("accept") ?? "";
    const wantsObject = accept.includes("application/vnd.pgrst.object+json");
    const representation = prefer.includes("return=representation");
    const wantsCount = /count=exact/.test(prefer);

    const finishRows = (rows: Row[], status = 200, extra: Record<string, string> = {}) => {
      if (wantsObject) {
        if (rows.length !== 1) {
          return json(
            {
              code: "PGRST116",
              message: "JSON object requested, multiple (or no) rows returned",
              details: `Results contain ${rows.length} rows`,
              hint: null,
            },
            406,
          );
        }
        return json(rows[0], status, extra);
      }
      return json(rows, status, extra);
    };

    try {
      if (isRpc) {
        const args = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
        const names = Object.keys(args);
        const params = names.map((n) => args[n]);
        const call = names.map((n, i) => `${ident(n)} := $${i + 1}`).join(", ");
        const res = await run(`select * from public.${ident(name)}(${call})`, params);
        const rows = rowsToJson(res);
        const scalar =
          rows.length > 0 &&
          rows.every((r) => Object.keys(r).length === 1 && Object.prototype.hasOwnProperty.call(r, name));
        if (scalar) {
          const values = rows.map((r) => r[name]);
          return json(values.length === 1 ? values[0] : values);
        }
        return json(rows);
      }

      const table = name;
      const params: unknown[] = [];
      if (method === "GET" || method === "HEAD") {
        const where = compileWhere(url, params);
        const cols = compileColumns(url);
        const order = compileOrder(url);
        const limit = url.searchParams.get("limit");
        const offset = url.searchParams.get("offset");
        let count: number | null = null;
        if (wantsCount) {
          const c = await run(`select count(*)::int as n from public.${ident(table)}${where}`, params);
          count = Number(c.rows[0].n);
        }
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-range": `*/${count ?? 0}` },
          });
        }
        const res = await run(
          `select ${cols} from public.${ident(table)}${where}${order}${limit ? ` limit ${Number(limit)}` : ""}${
            offset ? ` offset ${Number(offset)}` : ""
          }`,
          params,
        );
        const rows = rowsToJson(res);
        return finishRows(
          rows,
          200,
          count === null ? {} : { "content-range": `0-${Math.max(0, rows.length - 1)}/${count}` },
        );
      }

      if (method === "PATCH") {
        const patch = JSON.parse(bodyText) as Row;
        const sets = Object.keys(patch).map((k) => {
          params.push(patch[k] !== null && typeof patch[k] === "object" ? JSON.stringify(patch[k]) : patch[k]);
          return `${ident(k)} = $${params.length}`;
        });
        const where = compileWhere(url, params);
        if (sets.length === 0) return json([], 200);
        const res = await run(
          `update public.${ident(table)} set ${sets.join(", ")}${where}${representation ? " returning *" : ""}`,
          params,
        );
        return representation ? finishRows(rowsToJson(res)) : new Response(null, { status: 204 });
      }

      if (method === "POST") {
        const parsed = JSON.parse(bodyText) as Row | Row[];
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        if (rows.length === 0) return json([], 201);
        const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
        const valuesSql = rows
          .map(
            (r) =>
              `(${cols
                .map((c) => {
                  const v = r[c];
                  params.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
                  return `$${params.length}`;
                })
                .join(", ")})`,
          )
          .join(", ");
        const onConflict = url.searchParams.get("on_conflict");
        let conflict = "";
        if (onConflict) {
          const target = onConflict.split(",").map((c) => ident(c.trim())).join(", ");
          conflict = /resolution=ignore-duplicates/.test(prefer)
            ? ` on conflict (${target}) do nothing`
            : ` on conflict (${target}) do update set ${cols.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`;
        }
        const res = await run(
          `insert into public.${ident(table)} (${cols.map(ident).join(", ")}) values ${valuesSql}${conflict}${
            representation ? " returning *" : ""
          }`,
          params,
        );
        return representation ? finishRows(rowsToJson(res), 201) : new Response(null, { status: 201 });
      }

      if (method === "DELETE") {
        const where = compileWhere(url, params);
        const res = await run(
          `delete from public.${ident(table)}${where}${representation ? " returning *" : ""}`,
          params,
        );
        return representation ? finishRows(rowsToJson(res)) : new Response(null, { status: 204 });
      }
      throw new Error(`postgrest-double: unsupported method ${method}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("postgrest-double:")) throw err;
      return pgError(err);
    }
  }

  double.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(href);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const bodyText = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
    const cacheMode = init?.cache;
    const bypass = cacheMode === "no-store" || cacheMode === "no-cache";
    double.stats.requests += 1;
    if (bypass) double.stats.noStore += 1;
    const tableMatch = url.pathname.match(/^\/rest\/v1\/(?:rpc\/)?([a-z_][a-z0-9_]*)$/i);
    const record: RequestRecord = {
      method,
      path: url.pathname + url.search,
      table: tableMatch ? tableMatch[1] : null,
      cache: cacheMode,
      fromCache: false,
      status: 0,
    };
    double.requests.push(record);

    // Next's Data Cache key: url + method + headers + body (see
    // next/dist/server/lib/incremental-cache fetchCacheKey).
    let key: string | null = null;
    if (opts.dataCache && !bypass) {
      const h = Array.from(headers.entries())
        .sort()
        .map(([k, v]) => `${k}:${v}`)
        .join("|");
      key = createHash("sha256").update([href, method, h, bodyText].join(" ")).digest("hex");
      const stored = store.get(key);
      if (stored) {
        double.stats.cacheHits += 1;
        record.fromCache = true;
        record.status = stored.status;
        return new Response(stored.body === "" ? null : stored.body, {
          status: stored.status,
          headers: stored.headers,
        });
      }
    }

    const res = await execute(method, url, headers, bodyText);
    record.status = res.status;
    if (key && res.status === 200) {
      const body = await res.clone().text();
      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        hdrs[k] = v;
      });
      store.set(key, { status: res.status, headers: hdrs, body });
      double.stats.cacheStores += 1;
    }
    return res;
  }) as typeof fetch;

  return double;
}
