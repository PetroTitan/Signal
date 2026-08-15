import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  canTransitionItem,
  transitionItem,
} from "@/core/execution-engine/execution-state-machine";
import { isAutonomousDestination } from "@/core/publishing/publish-destinations";
import { FOUNDER_PLATFORMS } from "@/core/publishing/platform-guidance";

const REPO_ROOT = process.cwd();

/**
 * Manual distribution reachability.
 *
 * `execution_items.status = 'ready'` had exactly ONE writer in the
 * repository — `markItemReadyForPublish`, reachable only under
 * SAFE_TEST_MODE with platform='reddit'. So the entire manual publish
 * UI on /execution/items/[id], `prepareForManualPublishAction`, and
 * `recordManualDistributionAction` were unreachable for LinkedIn,
 * YouTube, Threads, Instagram and Indie Hackers. An approved LinkedIn
 * post sat at `approved` forever.
 *
 * Two things had to be true and neither was:
 *   1. something has to walk a manual item to `ready_for_manual_publish`;
 *   2. recording the result has to be a legal state transition.
 *
 * (2) is the quieter defect: `recordManualDistributionAction` went
 * straight to `completed`, which is not an edge from either `ready` or
 * `ready_for_manual_publish`, and `updateItemStatus` THROWS on an
 * illegal transition. It could never have succeeded. Nobody noticed
 * because (1) meant nobody could reach it.
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("the manual walk is legal in the state machine", () => {
  it("pending_authorization → authorized → ready → ready_for_manual_publish", () => {
    // The exact path prepareForManualDistributionAction takes. No
    // migration and no state-machine widening: every edge already
    // existed.
    expect(canTransitionItem("pending_authorization", "authorized")).toBe(true);
    expect(canTransitionItem("authorized", "ready")).toBe(true);
    expect(canTransitionItem("ready", "ready_for_manual_publish")).toBe(true);
  });

  it("never routes through `scheduled`", () => {
    // The load-bearing property. The tick selects status='scheduled',
    // so an item that never enters that status is invisible to it.
    // authorized → scheduled IS legal; the action must simply not use it.
    const source = stripComments(
      read("src/app/(app)/weekly-plan/_actions.ts"),
    );
    const start = source.indexOf(
      "export async function prepareForManualDistributionAction",
    );
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\nexport async function", start + 10);
    const body = source.slice(start, end === -1 ? undefined : end);
    expect(body).toContain('to: "ready_for_manual_publish"');
    expect(body).not.toContain('to: "scheduled"');
  });

  it("recording a manual publish is a legal walk", () => {
    // ready_for_manual_publish → completed is NOT an edge; going via
    // running is, and matches what the Reddit manual-record path does.
    expect(canTransitionItem("ready_for_manual_publish", "completed")).toBe(
      false,
    );
    expect(canTransitionItem("ready", "completed")).toBe(false);
    expect(canTransitionItem("ready_for_manual_publish", "running")).toBe(true);
    expect(canTransitionItem("ready", "running")).toBe(true);
    expect(canTransitionItem("running", "completed")).toBe(true);
  });

  it("an illegal transition throws rather than silently passing", () => {
    // Why (2) was fatal rather than cosmetic.
    expect(transitionItem("ready_for_manual_publish", "completed").ok).toBe(
      false,
    );
  });

  it("the record action walks through running", () => {
    const source = stripComments(
      read(
        "src/app/(app)/execution/items/[id]/_record-manual-distribution-action.ts",
      ),
    );
    const running = source.indexOf('to: "running"');
    const completed = source.indexOf('to: "completed"');
    expect(running, "must transition to running").toBeGreaterThan(-1);
    expect(completed, "must then complete").toBeGreaterThan(-1);
    expect(running).toBeLessThan(completed);
  });
});

describe("the scheduler cannot see a manual item", () => {
  it("the tick selects only status='scheduled'", () => {
    // Quoted rather than assumed: this single line is what makes a
    // manual execution item safe to create at all.
    const source = read("src/core/publishing/publishing-scheduler.ts");
    expect(source).toContain('.eq("status", "scheduled")');
  });

  it("no manual-prepare path sets a scheduled_at", () => {
    // A publish time would imply something will act on it. Nothing will.
    const source = stripComments(read("src/app/(app)/weekly-plan/_actions.ts"));
    const start = source.indexOf(
      "export async function prepareForManualDistributionAction",
    );
    const end = source.indexOf("\nexport async function", start + 10);
    const body = source.slice(start, end === -1 ? undefined : end);
    expect(body).toContain("scheduledAt: null");
  });
});

describe("manual and autonomous stay separate", () => {
  it("the prepare path refuses an autonomous destination", () => {
    const source = stripComments(read("src/app/(app)/weekly-plan/_actions.ts"));
    const start = source.indexOf(
      "export async function prepareForManualDistributionAction",
    );
    const end = source.indexOf("\nexport async function", start + 10);
    const body = source.slice(start, end === -1 ? undefined : end);
    expect(body).toContain("isAutonomousDestination(item.platform)");
  });

  it("the prepare path consults the retry firewall", () => {
    // It mints a FRESH execution item, so the scheduler's own retry
    // protection never applies to it — exactly the case the firewall
    // exists for. Mirrors scheduleApprovedItemAction.
    const source = stripComments(read("src/app/(app)/weekly-plan/_actions.ts"));
    const start = source.indexOf(
      "export async function prepareForManualDistributionAction",
    );
    const end = source.indexOf("\nexport async function", start + 10);
    const body = source.slice(start, end === -1 ? undefined : end);
    expect(body).toContain("evaluateRetryEligibilityFromMetadata");
  });

  it("exactly the manual platforms take the prepare path", () => {
    const manual = FOUNDER_PLATFORMS.filter((p) => !isAutonomousDestination(p));
    expect([...manual].sort()).toEqual([
      "indie_hackers",
      "instagram",
      "linkedin",
      "threads",
      "youtube",
    ]);
  });
});

// =====================================================================
// D3 — the execution detail page classifies from capability truth
// =====================================================================

describe("execution detail — distribution classification", () => {
  const source = read("src/app/(app)/execution/items/[id]/page.tsx");

  it("derives isDistribution instead of listing platforms", () => {
    const stripped = stripComments(source);
    expect(stripped).toContain("isAutonomousDestination(item.platform)");
    // The old literal listed x alongside the manual platforms.
    expect(stripped).not.toMatch(/isDistribution\s*=\s*[\s\S]{0,120}"x"/);
  });

  it("no longer treats X as a manual destination", () => {
    // X has had a real publisher and scheduler autonomy since F9, so
    // offering a copy-and-paste-it-yourself flow for it was a lie.
    expect(isAutonomousDestination("x")).toBe(true);
    for (const platform of ["linkedin", "youtube", "threads", "instagram"]) {
      expect(isAutonomousDestination(platform), platform).toBe(false);
    }
  });

  it("keeps tier-one as a separate CREDENTIAL question", () => {
    // dev.to / Hashnode / Bluesky offer an operator "publish now"
    // button because they publish with API-key credentials — not
    // because of anything to do with autonomy. Reddit and X are equally
    // autonomous and have no such button. Deriving tier-one from the
    // capability registry would conflate two different questions.
    const stripped = stripComments(source);
    expect(stripped).toMatch(/isTierOne\s*=[\s\S]{0,160}"devto"/);
    expect(stripped).toMatch(/isTierOne\s*=[\s\S]{0,160}"bluesky"/);
    expect(stripped).not.toMatch(/isTierOne\s*=[\s\S]{0,160}isAutonomous/);
  });

  it("renders the manual branch at ready_for_manual_publish", () => {
    // Where prepareForManualDistributionAction parks the item. Before
    // this, the branch only fired at `ready`, which manual platforms
    // could never reach.
    expect(source).toContain("isDistribution && (isReady || isReadyForManual)");
  });
});
