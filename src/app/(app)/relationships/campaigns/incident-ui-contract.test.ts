import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * What the campaign surfaces must SAY after the 2026-09-14 incident.
 *
 * Source-level, for the reason every UI contract in this repository is:
 * these components are wired to server actions that need a Next request
 * scope. What is asserted is the presence of the exact sentences and
 * the exact label mapping — the operator-facing half of the fix.
 */

const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const read = (rel: string) => code(readFileSync(path.join(process.cwd(), rel), "utf8"));

const FOLLOW_UI = read("src/app/(app)/relationships/campaigns/_campaign-ui.tsx");
const UNFOLLOW_UI = read("src/app/(app)/relationships/unfollow/[id]/_detail-view.tsx");
const LOADER = read("src/core/bluesky-campaigns/load-campaigns.server.ts");

describe("the primary UI says, in plain language, that the campaign continues", () => {
  for (const [name, src] of [["follow", FOLLOW_UI], ["unfollow", UNFOLLOW_UI]] as const) {
    it(`${name}: 'Signal will continue processing all N profiles automatically…'`, () => {
      expect(src).toMatch(/Signal will continue processing all\{" "\}/);
      expect(src).toMatch(/profiles\s+automatically across future days until every profile has a confirmed\s+outcome/);
      expect(src).toMatch(/The daily quota limits daily work, not the campaign size\./);
    });
  }
});

describe("outcomes are reported in three honest groups, never as 'all followed'", () => {
  it("achieved / impossible with reason / still pending", () => {
    expect(FOLLOW_UI).toContain("Desired state achieved");
    expect(FOLLOW_UI).toContain("Impossible, with reason");
    expect(FOLLOW_UI).toContain("Still pending");
    expect(FOLLOW_UI).not.toMatch(/all profiles followed/i);
  });

  it("every impossible reason is named, and 'checking with Bluesky' is distinct from 'retrying'", () => {
    for (const label of ["Account not found", "protected or not followable", "rejected by", "cancelled"]) {
      expect(FOLLOW_UI).toContain(label);
    }
    expect(FOLLOW_UI).toContain("checking with");
    expect(FOLLOW_UI).toContain("retrying");
    expect(LOADER).toMatch(/retrying: Math\.max\(0, counts\.retryable - reconciling\)/);
  });

  it("the denominator is the frozen total", () => {
    expect(FOLLOW_UI).toMatch(/<Stat label="Queued total" value=\{d\.counts\.total\.toLocaleString\(\)\} \/>/);
    // The breakdown is built from `counts` — the same frozen totals the
    // denominator uses — never from a separately fetched, shrinkable set.
    expect(LOADER).toMatch(/succeeded: counts\.succeeded,/);
    expect(LOADER).toMatch(/queued: counts\.queued,/);
    expect(LOADER).toMatch(/cancelled: counts\.cancelled,/);
  });

  it("links to the profiles that could not reach a final state", () => {
    expect(FOLLOW_UI).toMatch(/status=skipped/);
    expect(FOLLOW_UI).toMatch(/status=failed_structural/);
    expect(FOLLOW_UI).toMatch(/status=retryable/);
  });
});

describe("Daily Runs, the campaign and Accounts agree", () => {
  it("a run paused for reauthorization is labelled 'waiting for sign-in', never 'failed'", () => {
    expect(FOLLOW_UI).toMatch(
      /r\.status === "paused" && r\.last_error_code === "reauthorization_required"\s*\? "waiting for sign-in"/,
    );
    expect(FOLLOW_UI).toMatch(/r\.status === "failed"\s*\? "stopped — needs review"/);
  });

  it("an ACTIVE campaign with today's run waiting for sign-in tells the operator exactly what to do", () => {
    expect(LOADER).toMatch(
      /campaign\.status === "active" &&\s*today &&\s*\(today\.status === "paused" \|\| today\.status === "failed"\) &&\s*today\.last_error_code === "reauthorization_required"/,
    );
    expect(LOADER).toMatch(/Signal resumes today's run automatically once the session works/);
  });

  it("the reauthorization instruction says recovery is automatic — no Resume needed", () => {
    expect(LOADER).toMatch(/resumes the campaign — and today's run — automatically/);
  });
});
