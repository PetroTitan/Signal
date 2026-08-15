import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  firstMeaningfulBodyFragment,
  isDerivedLabel,
  planItemDisplayLabel,
} from "./plan-item-label";

const REPO_ROOT = process.cwd();
const SRC_ROOT = path.join(REPO_ROOT, "src");

describe("planItemDisplayLabel", () => {
  it("prefers a real operator-written title", () => {
    expect(
      planItemDisplayLabel({ title: "Shipped the retry firewall", body: "x" }),
    ).toBe("Shipped the retry firewall");
  });

  it("falls back to the first meaningful body line", () => {
    expect(
      planItemDisplayLabel({
        title: null,
        body: "We shipped the retry firewall today.\n\nMore below.",
      }),
    ).toBe("We shipped the retry firewall today.");
  });

  it("falls back to the platform when there is no content yet", () => {
    expect(
      planItemDisplayLabel({ title: "", body: "", platformLabel: "Bluesky" }),
    ).toBe("Bluesky post");
  });

  it("falls back to Untitled post when there is nothing at all", () => {
    expect(planItemDisplayLabel({ title: null, body: null })).toBe(
      "Untitled post",
    );
  });

  it("treats a whitespace-only title as absent", () => {
    expect(planItemDisplayLabel({ title: "   ", body: "Real body" })).toBe(
      "Real body",
    );
  });

  it("truncates a long fragment with an ellipsis", () => {
    const label = planItemDisplayLabel({ title: null, body: "a".repeat(400) });
    expect(label.length).toBeLessThanOrEqual(72);
    expect(label.endsWith("…")).toBe(true);
  });

  it("reports whether the label was derived", () => {
    expect(isDerivedLabel({ title: "Real", body: null })).toBe(false);
    expect(isDerivedLabel({ title: null, body: "Body" })).toBe(true);
    expect(isDerivedLabel({ title: "  ", body: "Body" })).toBe(true);
  });
});

describe("firstMeaningfulBodyFragment", () => {
  it("strips heading, quote and list syntax rather than skipping the line", () => {
    expect(firstMeaningfulBodyFragment("## Shipped it")).toBe("Shipped it");
    expect(firstMeaningfulBodyFragment("> A quote")).toBe("A quote");
    expect(firstMeaningfulBodyFragment("- First item")).toBe("First item");
    expect(firstMeaningfulBodyFragment("1. First item")).toBe("First item");
  });

  it("unwraps inline emphasis, code and links", () => {
    expect(firstMeaningfulBodyFragment("**Bold** start")).toBe("Bold start");
    expect(firstMeaningfulBodyFragment("*Italic* start")).toBe("Italic start");
    expect(firstMeaningfulBodyFragment("`code` start")).toBe("code start");
    expect(firstMeaningfulBodyFragment("[Signal](https://x) launched")).toBe(
      "Signal launched",
    );
  });

  it("skips fenced code blocks entirely", () => {
    expect(
      firstMeaningfulBodyFragment("```ts\nconst a = 1;\n```\nThe real opener."),
    ).toBe("The real opener.");
  });

  it("skips horizontal rules and image-only lines", () => {
    expect(firstMeaningfulBodyFragment("---\n![alt](u)\nActual text")).toBe(
      "Actual text",
    );
  });

  it("returns an empty string when nothing usable remains", () => {
    expect(firstMeaningfulBodyFragment("```\ncode\n```")).toBe("");
    expect(firstMeaningfulBodyFragment("")).toBe("");
    expect(firstMeaningfulBodyFragment(null)).toBe("");
  });
});

// =====================================================================
// Containment guard — a derived label must never become published text
// =====================================================================
//
// This is the assertion that makes the whole derived-label approach
// safe. Two title consumers are not obvious: transformers/hashnode
// derives the published URL slug from the title, and publish-fingerprint
// hashes it into the 30-day duplicate fingerprint. Both are on platforms
// that require a real title, so the derived path cannot reach them today
// — this guard is what keeps that true.

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Strip comments so a docstring mentioning the module name cannot
 *  produce a false positive. Mirrors the technique in
 *  approval-readiness-import-integrity.test.ts. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PUBLISHING_BOUNDARY = [
  /src\/core\/publishing\/publish-[a-z]+\.ts$/,
  /src\/core\/publishing\/transformers\//,
  /src\/core\/publishing\/publishing-(scheduler|runner)\.ts$/,
  /src\/core\/publishing\/[a-z-]+-publish-orchestrator\.ts$/,
  /src\/core\/publishing\/publish-fingerprint\.ts$/,
  /src\/core\/platform-native\/adapters\//,
  /src\/repositories\/(weekly-plan|execution-item|backlog|draft-variant)-repository\.ts$/,
];

describe("the derived label cannot reach published content", () => {
  const files = walk(SRC_ROOT);

  it("scanned a meaningful number of files", () => {
    // Guards the guard: a broken walk would make the check below pass
    // vacuously.
    expect(files.length).toBeGreaterThan(200);
  });

  it("no publisher, transformer, adapter, scheduler or repository imports it", () => {
    const boundaryFiles = files.filter((f) => {
      const rel = path.relative(REPO_ROOT, f).split(path.sep).join("/");
      return PUBLISHING_BOUNDARY.some((re) => re.test(rel));
    });
    // Guards the guard again — the boundary patterns must actually
    // match something.
    expect(boundaryFiles.length).toBeGreaterThan(15);

    const violations = boundaryFiles.filter((f) =>
      stripComments(fs.readFileSync(f, "utf8")).includes("plan-item-label"),
    );
    const detail = violations
      .map(
        (f) =>
          `${path.relative(REPO_ROOT, f)} imports plan-item-label — a display ` +
          `fallback must never enter a PublishRequest, a provider payload, ` +
          `a URL slug, or the duplicate fingerprint.`,
      )
      .join("\n");
    expect(detail).toBe("");
  });

  it("the scheduler still sources PublishRequest.title from the execution item", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src", "core", "publishing", "publishing-scheduler.ts"),
      "utf8",
    );
    expect(source).toContain("title: item.title");
  });
});
