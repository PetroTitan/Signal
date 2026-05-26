import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Architectural firewall — MCP must NOT import any per-platform
 * publisher, transformer, scheduler, orchestrator, or runner.
 *
 * The rule
 * --------
 * MCP code may only import:
 *   - shared deterministic helpers from `@/core/platform-native`
 *   - the shared `PublishPlatform` union from
 *     `@/core/publishing/publishing-types`
 *   - the publishing-result error helpers (if needed in future)
 *
 * MCP code MUST NOT import:
 *   - `@/core/publishing/transformers/*`     (provider text shaping)
 *   - `@/core/publishing/publish-*`           (provider HTTP calls)
 *   - `@/core/publishing/publishing-runner`   (dispatch)
 *   - `@/core/publishing/publishing-scheduler` (timing)
 *   - `@/core/publishing/bluesky-publish-orchestrator` (refresh/retry)
 *   - `@/core/platform-native/adapters/<platform>/` (provider-specific
 *     adapter — only the registry's getPlatformAdapter is allowed)
 *
 * Why a static scan
 * -----------------
 * A regression here is silent — an MCP file accidentally importing
 * `publish-bluesky.ts` would compile cleanly and tests would pass.
 * The scan asserts a concrete architectural property: no MCP file
 * mentions any forbidden import path, full stop. Fast, no extra
 * dependency, runs as a normal unit test.
 */

const MCP_ROOT = join(__dirname);

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  rule: string;
}> = [
  {
    pattern: /@\/core\/publishing\/transformers\//,
    rule: "Provider transformers must stay isolated to their per-platform adapter.",
  },
  {
    pattern: /@\/core\/publishing\/publish-(bluesky|x|linkedin|reddit|devto|hashnode|telegram)/,
    rule: "Provider publishers must not be imported by MCP — MCP only persists intent.",
  },
  {
    pattern: /@\/core\/publishing\/publishing-runner/,
    rule: "MCP must not invoke the dispatch runner directly.",
  },
  {
    pattern: /@\/core\/publishing\/publishing-scheduler/,
    rule: "MCP must not touch the scheduler.",
  },
  {
    pattern: /@\/core\/publishing\/bluesky-publish-orchestrator/,
    rule: "Provider orchestrators must stay isolated.",
  },
  {
    pattern: /@\/core\/platform-native\/adapters\/(?!registry)[a-z]+(?:\/|"|')/,
    rule:
      "MCP may not import a per-platform adapter directly — go through the registry's getPlatformAdapter only.",
  },
];

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      s.isFile() &&
      (full.endsWith(".ts") || full.endsWith(".tsx")) &&
      // Skip the isolation test itself (it lists the forbidden
      // strings on purpose) and any test file (test fixtures may
      // legitimately mock provider modules).
      !full.endsWith("mcp-isolation.test.ts") &&
      !full.endsWith(".test.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("MCP architectural firewall", () => {
  const files = listTsFiles(MCP_ROOT);

  it("finds at least the well-known MCP files (scan sanity check)", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith("/platform-intent.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/tools/prepare-tools.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("/tools/planning-tools.ts"))).toBe(true);
  });

  for (const { pattern, rule } of FORBIDDEN_PATTERNS) {
    it(`no MCP file matches ${pattern} — ${rule}`, () => {
      const violators: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        if (pattern.test(content)) {
          violators.push(file.replace(`${MCP_ROOT}/`, "src/mcp/"));
        }
      }
      expect(violators).toEqual([]);
    });
  }
});
