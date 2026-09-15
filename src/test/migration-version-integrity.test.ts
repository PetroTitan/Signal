import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

describe("migration version integrity", () => {
  it("assigns every migration a unique 14-digit version", () => {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const owners = new Map<string, string[]>();
    const malformed: string[] = [];

    for (const file of files) {
      const match = /^(\d{14})_[a-z0-9_]+\.sql$/.exec(file);
      if (!match) {
        malformed.push(file);
        continue;
      }
      const version = match[1]!;
      owners.set(version, [...(owners.get(version) ?? []), file]);
    }

    const duplicates = [...owners.entries()]
      .filter(([, versionOwners]) => versionOwners.length > 1)
      .map(([version, versionOwners]) => `${version}: ${versionOwners.join(", ")}`);

    expect(malformed, "migration filenames must be <14 digits>_<name>.sql").toEqual([]);
    expect(
      duplicates,
      "Supabase records only the timestamp prefix; duplicate versions make one migration invisible",
    ).toEqual([]);
  });
});
