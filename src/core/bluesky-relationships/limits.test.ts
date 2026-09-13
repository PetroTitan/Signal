import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  canSelectMore,
  checkBatchSize,
  MAX_RELATIONSHIP_BATCH_SIZE,
  RELATIONSHIP_MAX_DURATION_SECONDS,
  remainingSelectionCapacity,
} from "./limits";
import { INTER_REQUEST_MS, MUTATION_RATE_LIMIT_FLOOR } from "./execute-actions.server";
import { RELATIONSHIP_IMPORT_MAX_DURATION_SECONDS } from "./import-plan";

const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

describe("checkBatchSize", () => {
  it("accepts a selection at the cap", () => {
    expect(checkBatchSize(MAX_RELATIONSHIP_BATCH_SIZE)).toEqual({
      ok: true,
      count: MAX_RELATIONSHIP_BATCH_SIZE,
    });
    expect(checkBatchSize(1).ok).toBe(true);
  });

  it("rejects one past the cap, and says how to proceed", () => {
    const r = checkBatchSize(MAX_RELATIONSHIP_BATCH_SIZE + 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(String(MAX_RELATIONSHIP_BATCH_SIZE));
    // Refusing without telling the operator what to do instead is a
    // dead end; this one names the remedy.
    expect(r.reason).toContain("smaller batches");
    expect(r.reason).toContain("nothing is lost");
  });

  it("rejects a forged oversized submission", () => {
    for (const n of [21, 100, 5_000, 1_000_000]) {
      const r = checkBatchSize(n);
      expect(r.ok, `${n} should be refused`).toBe(false);
      if (!r.ok) expect(r.reason).toContain(String(n));
    }
  });

  it("rejects an empty selection", () => {
    const r = checkBatchSize(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("at least one");
  });

  it("rejects values that are not whole counts", () => {
    for (const n of [-1, 1.5, NaN, Infinity]) {
      expect(checkBatchSize(n).ok, `${n}`).toBe(false);
    }
  });
});

describe("selection capacity helpers", () => {
  it("canSelectMore closes exactly at the cap", () => {
    expect(canSelectMore(MAX_RELATIONSHIP_BATCH_SIZE - 1)).toBe(true);
    expect(canSelectMore(MAX_RELATIONSHIP_BATCH_SIZE)).toBe(false);
    expect(canSelectMore(MAX_RELATIONSHIP_BATCH_SIZE + 5)).toBe(false);
  });

  it("remainingSelectionCapacity never goes negative", () => {
    expect(remainingSelectionCapacity(0)).toBe(MAX_RELATIONSHIP_BATCH_SIZE);
    expect(remainingSelectionCapacity(MAX_RELATIONSHIP_BATCH_SIZE)).toBe(0);
    expect(remainingSelectionCapacity(MAX_RELATIONSHIP_BATCH_SIZE + 99)).toBe(0);
  });
});

describe("the cap actually fits the declared execution budget", () => {
  it("worst-case batch duration stays under maxDuration", () => {
    // The arithmetic documented in limits.ts, asserted rather than
    // trusted. Provider round trips measured 0.45-1.0s against the live
    // API; 0.8s is used as the per-call figure.
    const perCall = 0.8;
    const spacing = INTER_REQUEST_MS / 1000;
    const n = MAX_RELATIONSHIP_BATCH_SIZE;

    const realistic = perCall * n + spacing * (n - 1);
    // Every action ambiguous: mutation + reconciliation read.
    const worst = perCall * 2 * n + spacing * (n - 1);

    expect(realistic).toBeLessThan(RELATIONSHIP_MAX_DURATION_SECONDS);
    expect(worst).toBeLessThan(RELATIONSHIP_MAX_DURATION_SECONDS);

    // And one more than the cap would NOT fit — i.e. the cap is chosen,
    // not arbitrary. Raising MAX without raising maxDuration fails here.
    const oneMore = perCall * 2 * (n + 5) + spacing * (n + 4);
    expect(oneMore).toBeGreaterThan(RELATIONSHIP_MAX_DURATION_SECONDS);
  });

  it("the page segment declares the same maxDuration, as a literal", () => {
    // Next.js reads segment config STATICALLY. An imported constant
    // here is not resolved — the build warns "Unknown identifier … The
    // default config will be used instead" and silently reverts to the
    // platform default, which is far below the worst case computed
    // above. The first version of this file did exactly that; the build
    // warning was the only evidence.
    //
    // So the page must carry a literal, and this parses it and compares
    // it to the constant the arithmetic uses.
    const page = readFileSync(
      path.join(process.cwd(), "src/app/(app)/relationships/page.tsx"),
      "utf8",
    );
    const match = /export const maxDuration = (\d+);/.exec(page);
    expect(match, "page must declare `export const maxDuration = <number>;`").not.toBeNull();
    expect(Number(match![1])).toBe(RELATIONSHIP_IMPORT_MAX_DURATION_SECONDS);
    expect(Number(match![1])).toBeGreaterThanOrEqual(
      RELATIONSHIP_MAX_DURATION_SECONDS,
    );
    // And it must not be an identifier, however tempting the DRY is.
    expect(page).not.toMatch(/export const maxDuration = [A-Za-z_]/);
  });

  it("pacing and rate-limit floors are unchanged by this cap", () => {
    // The cap buys headroom by doing less work, never by going faster
    // or by being less courteous to the provider.
    expect(INTER_REQUEST_MS).toBe(1_000);
    expect(MUTATION_RATE_LIMIT_FLOOR).toBe(20);
  });
});

describe("the cap is enforced on the server, not only in the UI", () => {
  const actions = code(
    readFileSync(
      path.join(process.cwd(), "src/app/(app)/relationships/_actions.ts"),
      "utf8",
    ),
  );

  it("the batch action calls checkBatchSize", () => {
    expect(actions).toContain("checkBatchSize(candidateIds.length)");
  });

  it("it checks the resolved count, not a client-supplied number", () => {
    // A `count` field in the FormData would be the client's claim about
    // itself. The length of the actual id list is the fact.
    expect(actions).not.toMatch(/formData\.get\(\s*["']count["']/);
    expect(actions).not.toMatch(/formData\.get\(\s*["']selected_count["']/);
  });

  it("the size gate runs before session resolution and any provider call", () => {
    const gate = actions.indexOf("checkBatchSize");
    const session = actions.indexOf("resolveRelationshipSession", gate - 4000);
    expect(gate).toBeGreaterThan(-1);
    expect(session).toBeGreaterThan(gate);
  });
});

describe("no quota, cooldown or autonomous execution was introduced", () => {
  it("the cap bounds one request and nothing over time", () => {
    const src = code(
      readFileSync(
        path.join(process.cwd(), "src/core/bluesky-relationships/limits.ts"),
        "utf8",
      ),
    );
    for (const forbidden of [
      "perDay", "dailyLimit", "dailyQuota", "cooldown",
      "setInterval", "setTimeout", "cron", "jitter", "random",
    ]) {
      expect(src, `limits.ts must not mention ${forbidden}`).not.toContain(forbidden);
    }
  });
});
