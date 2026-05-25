import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Redirect-integrity regression guard.
 *
 * The /approval-queue route does not exist. The previous fix
 * introduced an `<a href="/approval-queue">` in the compose-sheet
 * modal that returned 404 in production. This test fails LOUD if any
 * future change re-introduces:
 *
 *   - href="/approval-queue"
 *   - router.push("/approval-queue")
 *   - redirect("/approval-queue")
 *   - revalidatePath("/approval-queue")
 *   - ComposeActionVariant "open_approval_queue"
 *
 * Conceptual references in docstrings (the phrase "approval queue"
 * without a URL) are allowed.
 */

const SRC_ROOT = join(__dirname, "..", "..", "..");

const ALLOWED_DESCRIPTIVE_PATTERNS = [
  // Test files may reference the regression they're guarding.
  /\.test\.tsx?$/,
];

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  re: RegExp;
  label: string;
}> = [
  { re: /href=["']\/approval-queue["']/g, label: 'href="/approval-queue"' },
  {
    re: /router\.push\(\s*["']\/approval-queue["']/g,
    label: 'router.push("/approval-queue")',
  },
  {
    re: /redirect\(\s*["']\/approval-queue["']/g,
    label: 'redirect("/approval-queue")',
  },
  {
    re: /revalidatePath\(\s*["']\/approval-queue["']/g,
    label: 'revalidatePath("/approval-queue")',
  },
  {
    re: /["']open_approval_queue["']/g,
    label: '"open_approval_queue" variant',
  },
];

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

describe("approval redirect integrity", () => {
  const files = walk(SRC_ROOT);

  for (const { re, label } of FORBIDDEN_PATTERNS) {
    it(`no source file contains: ${label}`, () => {
      const offenders: string[] = [];
      for (const f of files) {
        if (ALLOWED_DESCRIPTIVE_PATTERNS.some((p) => p.test(f))) continue;
        const text = readFileSync(f, "utf8");
        // Reset lastIndex since /g is shared.
        re.lastIndex = 0;
        if (re.test(text)) offenders.push(relative(SRC_ROOT, f));
      }
      expect(offenders, `Forbidden pattern "${label}" found in:\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});
