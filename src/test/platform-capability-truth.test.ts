import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  PLATFORMS_WITH_REAL_PUBLISHER,
} from "@/core/publishing/publishing-runner";
import { SCHEDULER_AUTONOMOUS_PLATFORMS } from "@/core/publishing/publishing-scheduler";
import { SCHEDULABLE_PLATFORMS } from "@/mcp/tools/schedule-tools";

/**
 * P0.3 — capability truth.
 *
 * One invariant governs every capability claim in the system:
 *
 *     MCP schedulable ⊆ scheduler autonomous ⊆ real publisher
 *
 * Each layer may be narrower than the one beneath it — MCP deliberately
 * exposes less than the scheduler can drive — but never wider. A wider
 * claim means the product advertises something that cannot succeed.
 *
 * This mattered concretely: LinkedIn sat in the scheduler's autonomous
 * set while `publishToLinkedIn` returned `not_implemented`, which the
 * scheduler maps to a TERMINAL `failed` status. The only reason it was
 * not an active incident is that the LinkedIn OAuth callback is also
 * unimplemented, so the policy gate refused earlier for a different
 * reason. A false capability claim propped up by an unrelated missing
 * feature is exactly the kind of state this invariant makes
 * unrepresentable.
 *
 * The declared "real publisher" set is itself checked against the
 * filesystem, so the declaration cannot drift from the code: a stub
 * added to the set, or a publisher implemented without being declared,
 * fails here.
 */

const REPO_ROOT = process.cwd();
const PUBLISHING_DIR = path.join(REPO_ROOT, "src", "core", "publishing");

/**
 * Identify publisher modules by what they EXPORT, not by filename:
 * `publish-fingerprint.ts` and `publish-retry-policy.ts` share the
 * prefix but publish nothing. A publisher exports `publishTo<Platform>`.
 *
 * A publisher is a STUB when it returns `publishNotImplemented` — the
 * marker the codebase already uses, and the outcome the scheduler maps
 * to a terminal failure.
 */
function publisherImplementationFromSource(): {
  real: string[];
  stub: string[];
} {
  const real: string[] = [];
  const stub: string[] = [];
  for (const file of fs.readdirSync(PUBLISHING_DIR).sort()) {
    const match = /^publish-([a-z]+)\.ts$/.exec(file);
    if (!match) continue;
    if (file.endsWith(".test.ts")) continue;
    const platform = match[1]!;
    const source = fs.readFileSync(path.join(PUBLISHING_DIR, file), "utf8");
    if (!/export\s+(async\s+)?function\s+publishTo[A-Za-z]+/.test(source)) {
      // Not a publisher — a helper that happens to share the prefix.
      continue;
    }
    if (source.includes("publishNotImplemented")) stub.push(platform);
    else real.push(platform);
  }
  return { real, stub };
}

describe("platform capability truth", () => {
  const fromSource = publisherImplementationFromSource();

  it("finds publisher modules to check", () => {
    // Guards the guard: a broken scan would make everything below pass
    // vacuously.
    expect(fromSource.real.length + fromSource.stub.length).toBeGreaterThan(5);
  });

  it("the declared real-publisher set matches the source", () => {
    expect([...PLATFORMS_WITH_REAL_PUBLISHER].sort()).toEqual(
      fromSource.real.sort(),
    );
  });

  it("no declared real publisher is actually a stub", () => {
    const declaredButStubbed = fromSource.stub.filter((p) =>
      (PLATFORMS_WITH_REAL_PUBLISHER as ReadonlySet<string>).has(p),
    );
    expect(declaredButStubbed).toEqual([]);
  });

  it("scheduler autonomous ⊆ real publisher", () => {
    const violations = [...SCHEDULER_AUTONOMOUS_PLATFORMS].filter(
      (p) => !(PLATFORMS_WITH_REAL_PUBLISHER as ReadonlySet<string>).has(p),
    );
    const detail = violations
      .map(
        (p) =>
          `"${p}" is claimed scheduler-autonomous but has no real publisher — ` +
          `the scheduler would drive it to a terminal failure.`,
      )
      .join("\n");
    expect(detail).toBe("");
  });

  it("MCP schedulable ⊆ scheduler autonomous", () => {
    const violations = [...SCHEDULABLE_PLATFORMS].filter(
      (p) => !(SCHEDULER_AUTONOMOUS_PLATFORMS as ReadonlySet<string>).has(p),
    );
    const detail = violations
      .map(
        (p) =>
          `"${p}" is MCP-schedulable but not scheduler-autonomous — an agent ` +
          `could schedule work the tick will refuse.`,
      )
      .join("\n");
    expect(detail).toBe("");
  });

  it("MCP schedulable ⊆ real publisher (transitive, stated explicitly)", () => {
    const violations = [...SCHEDULABLE_PLATFORMS].filter(
      (p) => !(PLATFORMS_WITH_REAL_PUBLISHER as ReadonlySet<string>).has(p),
    );
    expect(violations).toEqual([]);
  });

  it("linkedin is not claimed as autonomous or MCP-schedulable while stubbed", () => {
    expect(fromSource.stub).toContain("linkedin");
    expect(
      (SCHEDULER_AUTONOMOUS_PLATFORMS as ReadonlySet<string>).has("linkedin"),
    ).toBe(false);
    expect((SCHEDULABLE_PLATFORMS as ReadonlySet<string>).has("linkedin")).toBe(
      false,
    );
  });

  it("records where each layer is narrower, so narrowing stays deliberate", () => {
    // MCP is intentionally a strict subset: X has a real publisher and
    // is scheduler-autonomous, but the MCP surface does not expose it.
    // Widening that would be enabling a platform, which is out of scope
    // for a capability-truth fix. This assertion documents the gap so a
    // future change to it is a conscious decision rather than drift.
    const schedulerOnly = [...SCHEDULER_AUTONOMOUS_PLATFORMS].filter(
      (p) => !(SCHEDULABLE_PLATFORMS as ReadonlySet<string>).has(p),
    );
    expect(schedulerOnly.sort()).toEqual(["x"]);
  });
});
