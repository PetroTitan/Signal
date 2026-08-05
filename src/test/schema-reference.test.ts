import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Schema-reference integrity.
 *
 * Every table name that production source passes to `.from("…")` must
 * exist in `supabase/migrations`. This is a regression test for a real
 * class of defect: `signal.schedule_publish` spent its whole life
 * querying a `weekly_contracts` table that no migration creates. The
 * query errored, the error was discarded, and the failure read as
 * "no active contract" — so the authorization scope check never ran
 * once in production. Unit tests passed because the test double
 * invented the phantom table.
 *
 * A name-level check cannot catch a wrong *column*, but it makes an
 * entire table that does not exist impossible to ship.
 *
 * Deliberately narrow and deterministic: pure string scanning over
 * files already in the repository. No database, no network, no
 * ordering dependence.
 */

const REPO_ROOT = process.cwd();
const SRC_DIR = path.join(REPO_ROOT, "src");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");

/**
 * Table names referenced through PostgREST that are intentionally not
 * defined by a migration in this repository (for example a view owned
 * elsewhere, or a table in a non-public schema). Empty today — every
 * reference resolves. Adding an entry requires stating why.
 */
const ALLOWED_NON_MIGRATION_TABLES: ReadonlyMap<string, string> = new Map();

/** Table names that must never appear again. */
const BANNED_TABLE_NAMES: ReadonlyMap<string, string> = new Map([
  [
    "weekly_contracts",
    "Phantom table. The real approval contract table is weekly_approval_contracts; " +
      "scope lives in weekly_contract_{accounts,products,platforms,allowed_actions}. " +
      "The name survives only as an RLS policy label.",
  ],
]);

function listFiles(dir: string, predicate: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...listFiles(full, predicate));
    } else if (predicate(entry.name)) {
      out.push(full);
    }
  }
  return out.sort();
}

function migrationTableNames(): Set<string> {
  const names = new Set<string>();
  const files = listFiles(MIGRATIONS_DIR, (f) => f.endsWith(".sql"));
  for (const file of files) {
    const sql = fs.readFileSync(file, "utf8");
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) names.add(match[1]!.toLowerCase());
  }
  return names;
}

interface TableReference {
  table: string;
  file: string;
  line: number;
}

function productionTableReferences(): TableReference[] {
  const refs: TableReference[] = [];
  const files = listFiles(
    SRC_DIR,
    (f) =>
      (f.endsWith(".ts") || f.endsWith(".tsx")) &&
      !f.endsWith(".test.ts") &&
      !f.endsWith(".test.tsx"),
  );
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    // Scanned over whole-file content, not line by line, because
    // `supabase.storage` and `.from(...)` are routinely on separate
    // lines. `.storage.from("bucket")` addresses a storage bucket
    // rather than a table, so it is excluded structurally instead of
    // being allow-listed by bucket name — allow-listing the name would
    // also permit a real table of that name to go unchecked.
    const re = /(?<!\.storage\s*)\.from\(\s*"([a-z0-9_-]+)"\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const line = content.slice(0, match.index).split("\n").length;
      refs.push({
        table: match[1]!,
        file: path.relative(REPO_ROOT, file),
        line,
      });
    }
  }
  return refs;
}

describe("schema reference integrity", () => {
  const migrationTables = migrationTableNames();
  const references = productionTableReferences();

  it("parses a plausible set of tables out of the migrations", () => {
    // Guards the guard: if the migration parser silently matched
    // nothing, every assertion below would vacuously pass.
    expect(migrationTables.size).toBeGreaterThan(20);
    expect(migrationTables.has("weekly_approval_contracts")).toBe(true);
    expect(migrationTables.has("weekly_contract_accounts")).toBe(true);
    expect(migrationTables.has("weekly_contract_products")).toBe(true);
    expect(migrationTables.has("weekly_contract_platforms")).toBe(true);
    expect(migrationTables.has("weekly_contract_allowed_actions")).toBe(true);
    expect(migrationTables.has("execution_items")).toBe(true);
  });

  it("finds table references to check", () => {
    expect(references.length).toBeGreaterThan(20);
  });

  it("every table referenced by production source exists in a migration", () => {
    const unknown = references.filter(
      (ref) =>
        !migrationTables.has(ref.table) &&
        !ALLOWED_NON_MIGRATION_TABLES.has(ref.table),
    );
    const detail = unknown
      .map((ref) => `${ref.file}:${ref.line} → .from("${ref.table}")`)
      .join("\n");
    expect(detail).toBe("");
  });

  it("no production source references a banned table name", () => {
    const banned = references.filter((ref) => BANNED_TABLE_NAMES.has(ref.table));
    const detail = banned
      .map(
        (ref) =>
          `${ref.file}:${ref.line} → .from("${ref.table}") — ${BANNED_TABLE_NAMES.get(ref.table)}`,
      )
      .join("\n");
    expect(detail).toBe("");
  });

  it("the phantom weekly_contracts table is defined by no migration", () => {
    // If a migration ever creates it for real, this test must be
    // revisited deliberately rather than the ban silently going stale.
    expect(migrationTables.has("weekly_contracts")).toBe(false);
  });
});
