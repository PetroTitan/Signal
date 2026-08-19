import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../tool-registry";
import { TOOL_INPUT_SCHEMAS } from "../http/tool-input-schemas";

/**
 * MCP WORKSPACE-ISOLATION GUARD.
 *
 * The dispatcher hands every tool handler a SERVICE-ROLE Supabase client,
 * so RLS does not apply inside a tool. Workspace isolation rests entirely
 * on each query carrying `.eq("workspace_id", ctx.workspaceId)` — a
 * convention that was documented in tool-context.ts and enforced by
 * nothing. A handler that forgets it reads every workspace's rows.
 *
 * This is negative control 6: remove the workspace scope from a reader
 * and this test fails.
 *
 * The check is static rather than behavioural on purpose. A fake client
 * would only prove the guard on whichever code path the fake happened to
 * exercise; reading the source catches every `.from(` in the file,
 * including ones behind a branch a test never takes.
 */

const TOOLS_DIR = path.join(process.cwd(), "src/mcp/tools");

function toolSourceFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => path.join(TOOLS_DIR, f));
}

/** Statements that open a table read/write on the injected client. */
function tableAccesses(source: string): Array<{ table: string; index: number }> {
  const out: Array<{ table: string; index: number }> = [];
  const re = /\.from\(\s*"([a-z_]+)"\s*\)/g;
  for (const m of source.matchAll(re)) {
    out.push({ table: m[1], index: m.index ?? 0 });
  }
  return out;
}

/**
 * Tables that are legitimately not workspace-scoped, with the reason.
 * Anything not listed here must be scoped.
 */
const GLOBAL_TABLES: Record<string, string> = {
  mcp_operator_tokens: "keyed by token hash; the workspace is derived FROM it",
  workspaces: "the workspace row itself, fetched by id",
  workspace_members: "membership lookup, scoped by user + workspace id inline",
  metrics_refresh_runs:
    "a sweep spans every workspace, so a run is not workspace-owned; the " +
    "table carries no workspace identifier by design and assertNoIds " +
    "enforces that at the write",
};

describe("every social intelligence query is workspace-scoped", () => {
  const file = path.join(TOOLS_DIR, "social-intelligence-tools.ts");
  const source = readFileSync(file, "utf8");

  it("reads at least one table", () => {
    expect(tableAccesses(source).length).toBeGreaterThan(0);
  });

  it("scopes every table read to ctx.workspaceId", () => {
    for (const access of tableAccesses(source)) {
      if (GLOBAL_TABLES[access.table]) continue;
      // Look at the statement following the .from( call — a query chain
      // ends at the awaited destructuring assignment.
      const tail = source.slice(access.index, access.index + 1200);
      const statement = tail.split(/;\s*\n/)[0];
      expect(
        statement,
        `.from("${access.table}") is not scoped to ctx.workspaceId`,
      ).toMatch(/\.eq\(\s*"workspace_id"\s*,\s*ctx\.workspaceId\s*\)/);
    }
  });

  it("performs no write of any kind", () => {
    // These tools are read-only by contract; the registry says so and
    // this asserts the code agrees.
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(source, `social intelligence tools must not call ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });
});

describe("the shared status assembler is workspace-scoped too", () => {
  // The MCP measurement tools delegate to this rather than querying
  // directly, so the handler-level scan above would not see their reads.
  const file = path.join(
    process.cwd(),
    "src/core/metrics/health/load-measurement-status.server.ts",
  );
  const source = readFileSync(file, "utf8");

  it("scopes every workspace-owned read", () => {
    for (const access of tableAccesses(source)) {
      if (GLOBAL_TABLES[access.table]) continue;
      const statement = source.slice(access.index, access.index + 1200).split(/;\s*\n/)[0];
      expect(
        statement,
        `.from("${access.table}") is not scoped to the workspace`,
      ).toMatch(/\.eq\(\s*"workspace_id"\s*,\s*workspaceId\s*\)/);
    }
  });

  it("performs no write", () => {
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("the measurement tools perform no write", () => {
  const source = readFileSync(
    path.join(TOOLS_DIR, "measurement-health-tools.ts"),
    "utf8",
  );
  it("contains no mutation call", () => {
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(source).not.toContain(forbidden);
    }
  });
  it("cannot execute a backfill — preview only", () => {
    expect(source).not.toContain("executePlan");
    expect(source).toContain("Preview only");
  });
});

describe("the social tools are registered read-only", () => {
  const socialTools = TOOLS.filter((t) => t.name.startsWith("signal.social."));

  it("registers the full social surface", () => {
    expect(socialTools.map((t) => t.name).sort()).toEqual([
      "signal.social.account_health",
      "signal.social.backfill_preview",
      "signal.social.cadence",
      "signal.social.measurement_coverage",
      "signal.social.measurement_health",
      "signal.social.performance",
      "signal.social.recent_posts",
      "signal.social.recommend_next_action",
      "signal.social.refresh_history",
      "signal.social.repetition",
    ]);
  });

  it("declares none of them as writing or touching production", () => {
    for (const t of socialTools) {
      expect(t.writesDatabase, t.name).toBe(false);
      expect(t.touchesProduction, t.name).toBe(false);
      expect(t.riskLevel, t.name).toBe("safe_read");
      expect(t.approvalMode, t.name).toBe("no_approval_needed");
    }
  });

  it("requires a scope, and one that already exists", () => {
    for (const t of socialTools) {
      expect(t.requiredScopes.length, t.name).toBeGreaterThan(0);
      expect(t.requiredScopes, t.name).toContain("execution:read");
    }
  });

  it("follows the signal.<domain>.<action> naming convention", () => {
    for (const t of socialTools) {
      expect(t.name).toMatch(/^signal\.social\.[a-z][a-z0-9_]*$/);
    }
  });

  it("has a JSON input schema, keeping the drift test satisfied", () => {
    for (const t of socialTools) {
      expect(TOOL_INPUT_SCHEMAS[t.name], t.name).toBeTruthy();
      expect(TOOL_INPUT_SCHEMAS[t.name].type).toBe("object");
    }
  });
});

describe("the strategy loader is workspace-scoped too", () => {
  // The strategy tools delegate to this loader rather than querying
  // directly, and it receives the SERVICE-ROLE client from ctx.db — so
  // RLS does not apply and the explicit filter is the only isolation.
  const file = path.join(process.cwd(), "src/core/strategy/load-strategy.server.ts");
  const source = readFileSync(file, "utf8");

  it("reads at least one table", () => {
    expect(tableAccesses(source).length).toBeGreaterThan(0);
  });

  it("scopes every workspace-owned read", () => {
    for (const access of tableAccesses(source)) {
      if (GLOBAL_TABLES[access.table]) continue;
      const statement = source.slice(access.index, access.index + 1200).split(/;\s*\n/)[0];
      expect(
        statement,
        `.from("${access.table}") is not scoped to the workspace`,
      ).toMatch(/\.eq\(\s*"workspace_id"\s*,\s*workspaceId\s*\)/);
    }
  });

  it("performs no write", () => {
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("the strategy tools are registered read-only and advisory", () => {
  const strategyTools = TOOLS.filter((t) => t.name.startsWith("signal.strategy."));
  const source = readFileSync(path.join(TOOLS_DIR, "strategy-tools.ts"), "utf8");

  it("registers the full strategy surface", () => {
    expect(strategyTools.map((t) => t.name).sort()).toEqual([
      "signal.strategy.content_mix",
      "signal.strategy.cross_platform",
      "signal.strategy.experiments",
      "signal.strategy.recommendations",
      "signal.strategy.summary",
    ]);
  });

  it("contains no mutation call", () => {
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete("]) {
      expect(source, `strategy tools must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("cannot approve, schedule or publish", () => {
    // An advisory surface that could act would stop being advisory.
    for (const forbidden of ["approve", "schedulePublish", "publishNow", "executePlan"]) {
      expect(source, `strategy tools must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("tells every caller the options are not instructions", () => {
    expect(source).toContain("not instructions");
    expect(source).toContain("blocking: option.blocking");
  });

  it("declares none of them as writing or touching production", () => {
    for (const t of strategyTools) {
      expect(t.writesDatabase, t.name).toBe(false);
      expect(t.touchesProduction, t.name).toBe(false);
      expect(t.riskLevel, t.name).toBe("safe_read");
      expect(t.approvalMode, t.name).toBe("no_approval_needed");
    }
  });

  it("requires a scope, and one that already exists", () => {
    for (const t of strategyTools) {
      expect(t.requiredScopes, t.name).toContain("execution:read");
    }
  });

  it("follows the signal.<domain>.<action> naming convention", () => {
    for (const t of strategyTools) {
      expect(t.name).toMatch(/^signal\.strategy\.[a-z][a-z0-9_]*$/);
    }
  });

  it("has a JSON input schema, keeping the drift test satisfied", () => {
    for (const t of strategyTools) {
      expect(TOOL_INPUT_SCHEMAS[t.name], t.name).toBeTruthy();
      expect(TOOL_INPUT_SCHEMAS[t.name].type).toBe("object");
    }
  });
});

describe("the isolation guard actually detects a missing scope", () => {
  // Proves the test above is not vacuous: a handler written WITHOUT the
  // workspace filter must be caught by the same matcher.
  const unscoped = `
    export async function bad(ctx: ToolContext) {
      const { data } = await ctx.db
        .from("publish_history")
        .select("id")
        .limit(10);
      return data;
    }
  `;

  it("flags an unscoped query", () => {
    const accesses = tableAccesses(unscoped);
    expect(accesses).toHaveLength(1);
    const statement = unscoped.slice(accesses[0].index).split(/;\s*\n/)[0];
    expect(statement).not.toMatch(/\.eq\(\s*"workspace_id"\s*,\s*ctx\.workspaceId\s*\)/);
  });
});

describe("no tool file writes without declaring it", () => {
  it("every handler file that mutates is backed by a write-declaring tool", () => {
    // A softer sweep across the whole tools directory: if a file performs
    // a mutation, at least one registered tool must declare writesDatabase.
    const writingFiles = toolSourceFiles().filter((f) => {
      const src = readFileSync(f, "utf8");
      return [".insert(", ".update(", ".upsert(", ".delete("].some((m) =>
        src.includes(m),
      );
    });
    if (writingFiles.length > 0) {
      expect(TOOLS.some((t) => t.writesDatabase)).toBe(true);
    }
    expect(writingFiles.every((f) => !f.endsWith("social-intelligence-tools.ts"))).toBe(
      true,
    );
  });
});
