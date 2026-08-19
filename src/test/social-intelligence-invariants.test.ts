import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MIN_N_FOR_MEDIAN,
  MIN_N_FOR_VERDICT,
  compareGroups,
  containsCausalClaim,
  summarizeSample,
} from "@/core/intelligence/statistics";
import { analyzeRepetition } from "@/core/intelligence/repetition";
import { recommendNextActions } from "@/core/intelligence/recommendations";
import { buildAccountHealthPanel } from "@/core/intelligence/account-health";
import {
  metricAvailability,
  renderMetricCell,
  resolveMetricCell,
} from "@/core/metrics/metric-availability";
import {
  PLATFORM_METRIC_CAPABILITY,
  engagementCount,
} from "@/core/metrics/metrics-provider";
import { classifyFreshness, isPresentableAsCurrent } from "@/core/metrics/freshness";
import { classifyAgeWindow, readingForWindow } from "@/core/metrics/age-windows";
import { evaluateCostGate, estimateBackfillCost } from "@/core/metrics/backfill/backfill-cost";
import { planBackfill, MAX_BACKFILL_POSTS } from "@/core/metrics/backfill/backfill-plan";
import { TOOLS } from "@/mcp/tool-registry";

/**
 * THE INVARIANTS THIS MILESTONE EXISTS TO PROTECT.
 *
 * Each block is one of the required negative controls, written so the
 * BROKEN behaviour is constructed in the test rather than by editing
 * source. If a future change makes the broken behaviour possible, the
 * assertion fails here rather than shipping a confident-looking lie.
 */

// =====================================================================
// 1. Unavailable is never zero
// =====================================================================

describe("NEGATIVE CONTROL 1 — a missing metric must never render as zero", () => {
  it("Bluesky impressions render as words in every path", () => {
    for (const metrics of [null, {}, { likes: 3 }, { impressions: 0 } as never]) {
      const cell = resolveMetricCell("bluesky", "impressions", metrics);
      expect(cell.kind).not.toBe("value");
      expect(renderMetricCell(cell)).not.toMatch(/^\d+$/);
    }
  });

  it("engagement never counts an impression as an interaction", () => {
    expect(engagementCount({ impressions: 10_000 })).toBe(0);
  });

  it("a genuine provider zero is still shown, because that is a real value", () => {
    expect(resolveMetricCell("x", "likes", { likes: 0 })).toEqual({ kind: "value", value: 0 });
  });
});

// =====================================================================
// 2. X capability must not regress
// =====================================================================

describe("NEGATIVE CONTROL 2 — removing X metric capability must fail", () => {
  it("x is verified and reports impressions", () => {
    expect(PLATFORM_METRIC_CAPABILITY.x).toBe("verified");
    expect(metricAvailability("x", "impressions")).toBe("available");
  });

  it("no source file still claims an API tier blocks X metrics", () => {
    const offenders = sourceFiles(["src/core", "src/app", "src/mcp"]).filter((file) => {
      const src = readFileSync(file, "utf8");
      return /elevated\/paid API tier|Free tier blocks/i.test(src);
    });
    expect(offenders, `stale tier claim in: ${offenders.join(", ")}`).toEqual([]);
  });
});

// =====================================================================
// 3. Sample-size gates
// =====================================================================

describe("NEGATIVE CONTROL 3 — a verdict below the sample gate must be refused", () => {
  it("no median at all below the median gate", () => {
    for (let n = 0; n < MIN_N_FOR_MEDIAN; n += 1) {
      const s = summarizeSample(Array.from({ length: n }, (_, i) => i));
      expect(s.verdict, `n=${n}`).toBe("insufficient_data");
      expect(s.median, `n=${n}`).toBeNull();
    }
  });

  it("no verdict below the verdict gate, at any group size combination", () => {
    for (const n of [1, 5, 6, 12, MIN_N_FOR_VERDICT - 1]) {
      const c = compareGroups([
        { label: "a", values: Array.from({ length: n }, () => 3) },
        { label: "b", values: Array.from({ length: n }, () => 5) },
      ]);
      expect(c.verdict, `n=${n}`).not.toBe("verdict_permitted");
      expect(c.causalClaimPermitted).toBe(false);
    }
  });

  it("a large group cannot rescue a small one", () => {
    const c = compareGroups([
      { label: "big", values: Array.from({ length: 500 }, () => 10) },
      { label: "tiny", values: [1] },
    ]);
    expect(c.verdict).toBe("insufficient_data");
  });
});

// =====================================================================
// 4. No causal overclaim, anywhere
// =====================================================================

describe("NEGATIVE CONTROL 4 — causal API-penalty language must be caught", () => {
  it("recognises the forbidden sentence and its variants", () => {
    for (const claim of [
      "X penalizes Signal API posts by 38%",
      "X penalises API posts",
      "The account has been shadowbanned",
      "Reach dropped because of the API",
      "This proves automated posting hurts reach",
      "Bluesky suppresses scheduled content",
      "The platform classified this as spam",
    ]) {
      expect(containsCausalClaim(claim), claim).toBe(true);
    }
  });

  it("no string literal in the intelligence or metrics source makes a causal claim", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(["src/core/intelligence", "src/core/metrics"])) {
      if (file.endsWith(".test.ts")) continue;
      // Strip comments first: the modules deliberately QUOTE the
      // forbidden sentences to document what they must never emit, and a
      // documented counterexample is the opposite of a violation.
      const src = stripComments(readFileSync(file, "utf8"));
      for (const literal of src.matchAll(/"([^"\\]{20,300})"|'([^'\\]{20,300})'/g)) {
        const text = literal[1] ?? literal[2] ?? "";
        if (containsCausalClaim(text)) {
          offenders.push(`${path.basename(file)}: ${text.slice(0, 80)}`);
        }
      }
    }
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("every runtime output of the health panel is clean", () => {
    const panel = buildAccountHealthPanel({
      platform: "bluesky",
      handle: "webmasterid.bsky.social",
      nowIso: "2026-08-19T12:00:00Z",
      account: {
        platform: "bluesky",
        handle: "webmasterid.bsky.social",
        providerAccountId: "did:plc:x",
        followers: 1,
        following: 10,
        postCount: 22,
        createdAt: "2026-05-23T11:23:46Z",
        fetchedAt: "2026-08-19T12:00:00Z",
        source: "bluesky_getprofile",
      },
      posts: [
        { id: "a", platform: "bluesky", publishedAt: "2026-06-13T16:15:00Z", body: "One." },
      ],
      otherPlatformPosts: [],
      engagementSeries: [0, 0, 1],
      metricsFreshness: "stale",
      metricsAgeHours: 900,
    });
    const strings = [
      panel.summary,
      ...panel.signals.flatMap((s) => [s.label, s.evidence, s.value ?? ""]),
      ...recommendNextActions(panel).flatMap((r) => [r.action, r.rationale]),
    ];
    for (const text of strings) {
      expect(containsCausalClaim(text), text).toBe(false);
      expect(text.toLowerCase()).not.toMatch(/\bdead\b|shadowban|\bspammy\b/);
    }
  });
});

// =====================================================================
// 5. Cross-platform similarity must still catch the historical case
// =====================================================================

describe("NEGATIVE CONTROL 5 — the known historical pair must stay detected", () => {
  const X_BODY =
    "9 apps live. Not one of them is cool. ZIP extractor. PDF editor. Printer utility. " +
    "CV builder. Invoice maker. Card scanner. No brand needed, no launch needed, no trend " +
    "to catch. People search for the function, find the app, install it.";

  it("detects the real 2026-08-15 X↔Bluesky pair", () => {
    const report = analyzeRepetition([
      { id: "x", platform: "x", publishedAt: "2026-08-15T14:05:29Z", body: X_BODY },
      {
        id: "b",
        platform: "bluesky",
        publishedAt: "2026-08-15T14:25:20Z",
        body: `${X_BODY} Same demand this year as five years ago.`,
      },
    ]);
    const finding = report.findings.find((f) => f.kind === "cross_platform_copy");
    expect(finding, "the historical pair must be flagged").toBeTruthy();
    expect(finding!.severity).toBe("high");
  });

  it("does not fire on two genuinely different posts", () => {
    const report = analyzeRepetition([
      { id: "x", platform: "x", publishedAt: "2026-06-01T10:00:00Z", body: "Roaming charges surprise people who cross a border." },
      { id: "b", platform: "bluesky", publishedAt: "2026-06-01T10:05:00Z", body: "Instrumentation starts before the event name is chosen." },
    ]);
    expect(report.findings.some((f) => f.kind === "cross_platform_copy")).toBe(false);
  });
});

// =====================================================================
// 6. MCP workspace isolation
// =====================================================================

describe("NEGATIVE CONTROL 6 — an unscoped MCP reader must fail", () => {
  it("every social tool query carries the workspace filter", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/mcp/tools/social-intelligence-tools.ts"),
      "utf8",
    );
    const froms = Array.from(src.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g));
    expect(froms.length).toBeGreaterThan(0);
    for (const m of froms) {
      const statement = src.slice(m.index ?? 0).split(/;\s*\n/)[0];
      expect(statement, `unscoped .from("${m[1]}")`).toContain('.eq("workspace_id", ctx.workspaceId)');
    }
  });

  it("no social tool declares a write", () => {
    for (const tool of TOOLS.filter((t) => t.name.startsWith("signal.social."))) {
      expect(tool.writesDatabase, tool.name).toBe(false);
      expect(tool.touchesProduction, tool.name).toBe(false);
    }
  });
});

// =====================================================================
// 7. Stale data must never read as fresh
// =====================================================================

describe("NEGATIVE CONTROL 7 — presenting stale metrics as fresh must fail", () => {
  it("an old reading is stale and is not presentable as current", () => {
    const freshness = classifyFreshness({
      fetchedAtIso: "2026-06-01T00:00:00Z",
      nowIso: "2026-08-19T12:00:00Z",
      status: "connected",
    });
    expect(freshness).toBe("stale");
    expect(isPresentableAsCurrent(freshness)).toBe(false);
  });

  it("only 'fresh' is presentable without a caveat", () => {
    for (const f of ["stale", "unavailable", "rate_limited", "provider_error"] as const) {
      expect(isPresentableAsCurrent(f)).toBe(false);
    }
    expect(isPresentableAsCurrent("fresh")).toBe(true);
  });

  it("a missing age-window reading is never interpolated", () => {
    const readings = [
      { ageWindow: "1h" as const, value: 1 },
      { ageWindow: "7d" as const, value: 100 },
    ];
    expect(readingForWindow(readings, "24h")).toBeNull();
    expect(classifyAgeWindow(null)).toBeNull();
  });
});

// =====================================================================
// 8. Backfill bounds and cost gate
// =====================================================================

describe("NEGATIVE CONTROL 8 — an unbounded or unpriced backfill must be refused", () => {
  const RANGE = { since: "2020-01-01T00:00:00Z", until: "2030-01-01T00:00:00Z" };

  it("caps maxPosts however large the caller asks", () => {
    expect(planBackfill({ candidates: [], bounds: { ...RANGE, maxPosts: 1e9 } }).bounds.maxPosts).toBe(
      MAX_BACKFILL_POSTS,
    );
  });

  it("refuses a paid run with no confirmation", () => {
    const gate = evaluateCostGate(estimateBackfillCost({ x: 500 }), null);
    expect(gate.allowed).toBe(false);
  });

  it("refuses entirely when a platform has no documented rate", () => {
    const gate = evaluateCostGate(estimateBackfillCost({ mastodon: 1 }), 1e6);
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.reason).toBe("unpriced_platform");
  });

  it("the backfill route is POST-only and dry-run by default", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/app/api/metrics/backfill/route.ts"),
      "utf8",
    );
    expect(src).toContain("export async function POST");
    expect(src).not.toContain("export async function GET");
    expect(src).toContain("const execute = body.execute === true");
    expect(src).toContain('mode: "dry_run"');
  });
});

// =====================================================================
// Automation boundary
// =====================================================================

describe("no engagement automation exists anywhere in this subsystem", () => {
  it("no source file calls a provider engagement write endpoint", () => {
    const forbidden = [
      "/2/users/:id/likes",
      "app.bsky.feed.like",
      "app.bsky.graph.follow",
      "/2/users/:id/following",
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(["src/core/intelligence", "src/core/metrics"])) {
      const src = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (src.includes(pattern)) offenders.push(`${path.basename(file)}: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every recommendation is marked non-automatable", () => {
    const panel = buildAccountHealthPanel({
      platform: "x",
      handle: "Webmasteridcore",
      nowIso: "2026-08-19T12:00:00Z",
      account: null,
      posts: [],
      otherPlatformPosts: [],
      engagementSeries: [],
      metricsFreshness: null,
      metricsAgeHours: null,
    });
    for (const r of recommendNextActions(panel)) {
      expect(r.automatable, r.kind).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------

/** Remove block and line comments so documentation is not scanned. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function sourceFiles(roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    walk(path.join(process.cwd(), root), out);
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
}
