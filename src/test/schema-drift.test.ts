import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLICATION_METHODS } from "@/core/publishing/publication-method";
import { AGE_WINDOWS } from "@/core/metrics/age-windows";

/**
 * SQL CHECK ↔ TypeScript union drift guard.
 *
 * `src/lib/supabase/types.ts` is hand-written and there is no generated
 * schema snapshot, so nothing previously stopped a migration widening a
 * CHECK while the matching TS union stayed narrow — TypeScript would
 * then mistype real rows with zero test failures, which is the quiet
 * kind of wrong this milestone is supposed to eliminate.
 *
 * These tests parse the actual migration SQL and assert set equality
 * with the TS constants. They fail on drift in EITHER direction.
 */

const MIGRATION = path.join(
  process.cwd(),
  "supabase/migrations/20260819000001_social_performance_intelligence.sql",
);

function sql(): string {
  return readFileSync(MIGRATION, "utf8");
}

/** Pull the quoted literals out of a `... in ('a','b')` clause. */
function checkLiterals(source: string, pattern: RegExp): string[] {
  const match = pattern.exec(source);
  if (!match) return [];
  return Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]).sort();
}

describe("publish_history.mode — SQL and TypeScript agree", () => {
  it("the CHECK constraint lists exactly the PublishHistoryMode members", () => {
    const literals = checkLiterals(
      sql(),
      /check\s*\(mode in \(([^)]*)\)\)/i,
    );
    expect(literals).toEqual([...PUBLICATION_METHODS].sort());
  });

  it("still permits the two values already in production", () => {
    // 92 existing rows are 'api'. Dropping either value from the CHECK
    // would make the migration destructive.
    const literals = checkLiterals(sql(), /check\s*\(mode in \(([^)]*)\)\)/i);
    expect(literals).toContain("api");
    expect(literals).toContain("manual");
  });

  it("drops the old constraint unconditionally so a rename fails loudly", () => {
    // `drop constraint if exists` would silently no-op on a name
    // mismatch and leave the OLD narrow constraint in force — new-mode
    // inserts would then fail in production while the migration
    // reported success.
    expect(sql()).toMatch(
      /alter table public\.publish_history\s+drop constraint publish_history_mode_check;/,
    );
    expect(sql()).not.toMatch(/drop constraint if exists publish_history_mode_check/);
  });
});

describe("post_metrics provenance columns", () => {
  it("adds every column the provenance model needs", () => {
    const source = sql();
    for (const column of [
      "provider_published_at",
      "age_hours",
      "age_window",
      "freshness",
      "confidence",
      "provider_payload_version",
    ]) {
      expect(source).toContain(`add column if not exists ${column}`);
    }
  });

  it("age_window literals match the AGE_WINDOWS constant", () => {
    const literals = checkLiterals(
      sql(),
      /age_window is null or age_window in \(([^)]*)\)/i,
    );
    expect(literals).toEqual([...AGE_WINDOWS].sort());
  });

  it("freshness literals match the documented states", () => {
    const literals = checkLiterals(
      sql(),
      /freshness is null or freshness in\s*\n?\s*\(([^)]*)\)/i,
    );
    expect(literals).toEqual(
      ["fresh", "provider_error", "rate_limited", "stale", "unavailable"].sort(),
    );
  });

  it("every added column is nullable with no default — absent provenance stays unknown", () => {
    const source = sql();
    const addBlock = /add column if not exists (\w+)[^,;]*/g;
    for (const m of source.matchAll(addBlock)) {
      expect(m[0]).not.toMatch(/\bdefault\b/i);
      expect(m[0]).not.toMatch(/\bnot null\b/i);
    }
  });
});

describe("the migration is additive", () => {
  it("drops no column and no table", () => {
    const source = sql().toLowerCase();
    expect(source).not.toMatch(/drop column/);
    expect(source).not.toMatch(/drop table/);
  });

  it("rewrites no existing row", () => {
    // No UPDATE, no data backfill. Existing rows keep their values and
    // gain NULL provenance, which is the honest state for them.
    const source = sql().toLowerCase();
    expect(source).not.toMatch(/^\s*update\s+public\./m);
    expect(source).not.toMatch(/\bdelete from\b/);
  });

  it("does not change the mode default", () => {
    expect(sql().toLowerCase()).not.toMatch(/alter column mode set default/);
  });

  it("creates account_snapshots with RLS enabled", () => {
    const source = sql();
    expect(source).toContain("create table if not exists public.account_snapshots");
    expect(source).toContain(
      "alter table public.account_snapshots enable row level security",
    );
    expect(source).toContain("public.is_workspace_member(workspace_id)");
  });

  it("account_snapshots counters are nullable — the provider not saying is not zero", () => {
    const table = /create table if not exists public\.account_snapshots \(([\s\S]*?)\n\);/.exec(
      sql(),
    );
    expect(table).toBeTruthy();
    const body = table![1];
    for (const column of ["followers", "following", "post_count"]) {
      const line = body
        .split("\n")
        .find((l) => l.trim().startsWith(column));
      expect(line, `${column} column`).toBeTruthy();
      expect(line!).not.toMatch(/not null/i);
      expect(line!).not.toMatch(/default 0/i);
    }
  });
});
