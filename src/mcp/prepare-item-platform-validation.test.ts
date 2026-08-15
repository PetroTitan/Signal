import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  isPreparablePlatform,
  parseWeeklyPlanPrepareItem,
  ACCOUNTS_PREPARE_PLATFORMS,
} from "./schemas";
import { mcpInputSchemaFor } from "./http/tool-input-schemas";
import { FOUNDER_PLATFORMS } from "@/core/publishing/platform-guidance";
import { SCHEDULABLE_PLATFORMS } from "./tools/schedule-tools";

/**
 * signal.weekly_plan.prepare_item platform validation.
 *
 * Before this gate, `platform` was passed straight through
 * (`String(input.platform)`), so an agent could mint a plan item on any
 * string at all. `weekly_plan_items.platform` is unconstrained `text`,
 * so the row inserted cleanly and the item only died much later at the
 * scheduler's allowlist — as a blocked execution item the operator had
 * to clean up.
 *
 * The rule being pinned here has two halves that pull in opposite
 * directions, and both matter:
 *
 *   - preparation is NOT publication, so every founder platform is
 *     valid, INCLUDING the manual-only ones;
 *   - validating preparation must not widen what can be SCHEDULED.
 */

/** Remove block and line comments so source assertions test code, not
 *  the prose that describes it. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function args(over: Record<string, unknown> = {}) {
  return { title: "A title", ...over };
}

describe("prepare_item accepts every real destination", () => {
  it.each([...FOUNDER_PLATFORMS])("accepts %s", (platform) => {
    const parsed = parseWeeklyPlanPrepareItem(args({ platform }));
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  });

  it("accepts a manual-only platform — preparation is not publication", () => {
    // The distinction the whole gate turns on. Preparing LinkedIn
    // content is a first-class operation; refusing it here would break
    // the manual workflow rather than protect anything.
    for (const platform of ["linkedin", "youtube", "threads", "instagram", "indie_hackers"]) {
      const parsed = parseWeeklyPlanPrepareItem(args({ platform }));
      expect(parsed.ok, platform).toBe(true);
    }
  });

  it("accepts a null or absent platform", () => {
    // An item may be prepared before its destination is chosen.
    expect(parseWeeklyPlanPrepareItem(args({ platform: null })).ok).toBe(true);
    expect(parseWeeklyPlanPrepareItem(args()).ok).toBe(true);
  });

  it("trims a padded value rather than rejecting it", () => {
    const parsed = parseWeeklyPlanPrepareItem(args({ platform: "  bluesky  " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.platform).toBe("bluesky");
  });
});

describe("prepare_item refuses anything that is not a real destination", () => {
  it.each(["myspace", "REDDIT", "reddit ", "blue sky", "twitter", "mastodon"])(
    "refuses %j",
    (platform) => {
      const parsed = parseWeeklyPlanPrepareItem(args({ platform }));
      // "reddit " trims to a valid value; everything else must refuse.
      if (platform.trim() === "reddit") {
        expect(parsed.ok).toBe(true);
        return;
      }
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors).toContain("platform_unsupported");
    },
  );

  it("refuses a non-string platform", () => {
    for (const platform of [42, true, {}, []]) {
      const parsed = parseWeeklyPlanPrepareItem(args({ platform }));
      expect(parsed.ok, String(platform)).toBe(false);
      if (!parsed.ok) {
        expect(
          parsed.errors.includes("platform_must_be_string") ||
            parsed.errors.includes("platform_unsupported"),
        ).toBe(true);
      }
    }
  });

  it("refuses an empty or whitespace-only platform", () => {
    for (const platform of ["", "   "]) {
      const parsed = parseWeeklyPlanPrepareItem(args({ platform }));
      expect(parsed.ok, JSON.stringify(platform)).toBe(false);
    }
  });

  it("uses a structured refusal, not a thrown error", () => {
    const parsed = parseWeeklyPlanPrepareItem(args({ platform: "myspace" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(Array.isArray(parsed.errors)).toBe(true);
      expect(parsed.errors).toContain("platform_unsupported");
    }
  });
});

describe("the allowlist is derived, not duplicated", () => {
  it("isPreparablePlatform accepts exactly the founder platforms", () => {
    for (const platform of FOUNDER_PLATFORMS) {
      expect(isPreparablePlatform(platform), platform).toBe(true);
    }
    expect(isPreparablePlatform("myspace")).toBe(false);
    expect(isPreparablePlatform(null)).toBe(false);
    expect(isPreparablePlatform(undefined)).toBe(false);
  });

  it("matches the accounts.prepare allowlist — one source, two tools", () => {
    expect([...ACCOUNTS_PREPARE_PLATFORMS].sort()).toEqual(
      [...FOUNDER_PLATFORMS].sort(),
    );
  });

  it("declares no second literal list in the parser", () => {
    // Non-duplication is the point. A future edit that inlines the
    // platform names here instead of deriving them fails.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "mcp", "schemas.ts"),
      "utf8",
    );
    const start = source.indexOf("export function isPreparablePlatform");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("FOUNDER_PLATFORMS");
    expect(body).not.toMatch(/"(reddit|bluesky|linkedin)"/);
  });
});

describe("the two schema surfaces agree", () => {
  const schema = mcpInputSchemaFor("signal.weekly_plan.prepare_item");

  it("exists and constrains platform with an enum", () => {
    expect(schema).toBeDefined();
    const platform = (
      schema.properties as Record<string, { enum?: unknown[] }>
    ).platform;
    expect(platform).toBeDefined();
    expect(Array.isArray(platform.enum)).toBe(true);
  });

  it("the JSON-Schema enum matches the parser's allowlist exactly", () => {
    // Two enforcement surfaces — the declared JSON Schema an MCP client
    // reads, and the hand-rolled parser the handler runs. If they
    // disagree, a client is told one thing and refused another.
    const platform = (
      schema.properties as Record<string, { enum: unknown[] }>
    ).platform;
    const declared = platform.enum.filter((v) => v !== null) as string[];
    expect(declared.sort()).toEqual([...FOUNDER_PLATFORMS].sort());
    // null must remain valid — destination-less preparation.
    expect(platform.enum).toContain(null);
  });
});

describe("validating preparation cannot widen scheduling", () => {
  it("schedulable stays a strict subset of preparable", () => {
    // The load-bearing separation. prepare_item now accepts 11
    // platforms; schedule_publish still accepts 5. Making preparation
    // permissive must never make scheduling permissive.
    for (const platform of SCHEDULABLE_PLATFORMS) {
      expect(isPreparablePlatform(platform), platform).toBe(true);
    }
    expect(SCHEDULABLE_PLATFORMS.size).toBeLessThan(FOUNDER_PLATFORMS.length);
  });

  it("a manual platform is preparable but not schedulable", () => {
    for (const platform of ["linkedin", "youtube", "threads", "instagram", "indie_hackers"]) {
      expect(isPreparablePlatform(platform), platform).toBe(true);
      expect(
        (SCHEDULABLE_PLATFORMS as ReadonlySet<string>).has(platform),
        platform,
      ).toBe(false);
    }
  });

  it("the parser does not import the schedulable set", () => {
    // Structural proof that one cannot leak into the other.
    //
    // Comments are stripped first: the module's own docstring explains
    // the separation and names SCHEDULABLE_PLATFORMS while doing so, so
    // a raw substring check would fail on prose rather than on code.
    const source = stripComments(
      fs.readFileSync(path.join(process.cwd(), "src", "mcp", "schemas.ts"), "utf8"),
    );
    expect(source).not.toContain("SCHEDULABLE_PLATFORMS");
    expect(source).not.toContain("schedule-tools");
  });
});
