import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Import-integrity regression guard for the approval-readiness split.
 *
 * The pure shared module (`approval-readiness.shared.ts`) MUST NOT
 * pull in `server-only` or any repository module. If it does, every
 * UI file that imports it will fail the Next.js production build
 * with the "You're importing a component that needs server-only"
 * error.
 *
 * Conversely, the server module (`approval-readiness.server.ts`) is
 * the only place that may import the creative repo.
 *
 * UI files (`"use client"` and their component graph) MUST NOT
 * import from the server module.
 *
 * This test walks src/ source files and enforces all of the above.
 */

const SRC_ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === ".next" ||
        entry === ".git"
      ) {
        continue;
      }
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC_ROOT);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Strip TypeScript comments (// and /* * /) before doing pattern
 * checks so the regression assertions match REAL imports, not
 * documentation that mentions `import "server-only"` literally.
 */
function stripComments(text: string): string {
  // Block comments — non-greedy.
  let out = text.replace(/\/\*[\s\S]*?\*\//g, "");
  // Line comments — preserves URLs in strings by only matching `//`
  // outside of quoted contexts (best-effort; our source files don't
  // mix quoted `//` patterns in import lines).
  out = out
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return out;
}

const SHARED_PATH = join(
  SRC_ROOT,
  "app",
  "(app)",
  "weekly-plan",
  "approval-readiness.shared.ts",
);

const SERVER_PATH = join(
  SRC_ROOT,
  "app",
  "(app)",
  "weekly-plan",
  "approval-readiness.server.ts",
);

const CARD_PATH = join(
  SRC_ROOT,
  "app",
  "(app)",
  "weekly-plan",
  "_plan-item-card.tsx",
);

describe("approval-readiness.shared.ts must stay client-safe", () => {
  it("does not contain `import \"server-only\"`", () => {
    expect(stripComments(read(SHARED_PATH))).not.toMatch(/import\s+["']server-only["']/);
  });

  it("does not import from @/repositories/*", () => {
    expect(stripComments(read(SHARED_PATH))).not.toMatch(
      /from\s+["']@\/repositories\//,
    );
  });

  it("does not import from the server module", () => {
    expect(stripComments(read(SHARED_PATH))).not.toMatch(
      /from\s+["']\.\/approval-readiness\.server["']/,
    );
  });

  it("does not import from any _actions.ts", () => {
    expect(stripComments(read(SHARED_PATH))).not.toMatch(
      /from\s+["'][^"']*_actions["']/,
    );
  });
});

describe("approval-readiness.server.ts is the only readiness module that imports server-only", () => {
  it("has `import \"server-only\"` at the top", () => {
    expect(stripComments(read(SERVER_PATH))).toMatch(/import\s+["']server-only["']/);
  });

  it("imports the creative repo (which is server-only)", () => {
    expect(stripComments(read(SERVER_PATH))).toMatch(
      /weekly-plan-creative-repository/,
    );
  });
});

describe("UI components must not pull approval-readiness.server", () => {
  it("_plan-item-card.tsx does not import approval-readiness.server", () => {
    expect(stripComments(read(CARD_PATH))).not.toMatch(
      /from\s+["']\.\/approval-readiness\.server["']/,
    );
  });

  it("_plan-item-card.tsx does not import the creative repository directly", () => {
    expect(stripComments(read(CARD_PATH))).not.toMatch(
      /from\s+["']@\/repositories\/weekly-plan-creative-repository["']/,
    );
  });

  it("no \"use client\" file outside _actions.ts imports approval-readiness.server", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const raw = read(f);
      const text = stripComments(raw);
      const isClientLike =
        raw.includes('"use client"') || raw.includes("'use client'");
      if (!isClientLike) continue;
      if (/from\s+["'][^"']*approval-readiness\.server["']/.test(text)) {
        offenders.push(relative(SRC_ROOT, f));
      }
    }
    expect(
      offenders,
      `Client files importing approval-readiness.server:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("no legacy `./approval-readiness` (combined) imports remain", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = stripComments(read(f));
      // The combined module was removed. Match exact "./approval-readiness"
      // (no .shared / .server suffix).
      if (/from\s+["']\.\/approval-readiness["']/.test(text)) {
        offenders.push(relative(SRC_ROOT, f));
      }
    }
    expect(
      offenders,
      `Stale imports of the combined module:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
