/**
 * Compose sheet — source-level regression guards.
 *
 * The sheet itself uses client-only React hooks (useFormState,
 * useRouter, useTransition) which can't be cleanly rendered via
 * react-dom/server without setting up RTL. These guards instead
 * lock in the deep-link URL contract via source assertions so a
 * future refactor can't silently drop the ?focus=<itemId>
 * parameter or the silent-fallback paragraph.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHEET_PATH = join(
  process.cwd(),
  "src",
  "app",
  "(app)",
  "accounts",
  "_generate-draft-sheet.tsx",
);
const sheetSource = readFileSync(SHEET_PATH, "utf8");

describe("compose sheet — deep link contract", () => {
  it("constructs a /weekly-plan?focus=<itemId> URL using the created plan-item id", () => {
    // Must encode the itemId before interpolating to keep query
    // strings safe.
    expect(sheetSource).toMatch(
      /\/weekly-plan\?focus=\$\{encodeURIComponent\(safe\.itemId\)\}/,
    );
  });

  it("falls back to /weekly-plan without ?focus when itemId is absent", () => {
    expect(sheetSource).toContain('"/weekly-plan"');
  });

  it("does not auto-navigate on success (no queueMicrotask navigation)", () => {
    // The previous behavior was a queueMicrotask + router.push that
    // navigated immediately on success — that hid the preview.
    // Regression guard: the only router.push call should be inside
    // the explicit "Open in weekly plan" button.
    const lines = sheetSource.split("\n");
    const microtaskNavLines = lines.filter(
      (l) => l.includes("queueMicrotask") && sheetSource.match(/queueMicrotask[\s\S]{0,80}router\.push/),
    );
    expect(microtaskNavLines).toEqual([]);
  });

  it("renders the silent fallback paragraph when envelope is null", () => {
    expect(sheetSource).toContain("Draft saved");
    expect(sheetSource).toContain("Open it on the weekly plan");
    // Must NOT contain alarm copy about the envelope being missing.
    expect(sheetSource.toLowerCase()).not.toContain("envelope not available");
    expect(sheetSource.toLowerCase()).not.toContain("envelope unavailable");
  });
});

describe("compose sheet — preview integration", () => {
  it("imports PlatformNativePreview from the local module", () => {
    expect(sheetSource).toContain('import { PlatformNativePreview }');
  });

  it("conditionally renders the preview only when envelope is present", () => {
    expect(sheetSource).toContain("envelope ? (");
    expect(sheetSource).toContain("<PlatformNativePreview draft={envelope} />");
  });
});
