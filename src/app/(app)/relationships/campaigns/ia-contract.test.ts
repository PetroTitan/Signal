import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Information architecture and detail-screen contracts, read from the
 * source the way the other UI contracts in this tree are.
 *
 * PRODUCTION (2026-09-15 canary): an unfollow campaign was listed under
 * a heading that said "Follow campaigns", and opening it rendered the
 * follow page with a setup form of default values beneath it. These
 * pin the shape that prevents both.
 */

const code = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
const read = (rel: string) => code(readFileSync(path.join(process.cwd(), rel), "utf8"));

const SIDEBAR = read("src/components/sidebar.tsx");
const PAGE = read("src/app/(app)/relationships/campaigns/page.tsx");
const UI = read("src/app/(app)/relationships/campaigns/_campaign-ui.tsx");
const LOADER = read("src/core/bluesky-campaigns/load-campaigns.server.ts");
const DETAIL_PAGE = read("src/app/(app)/relationships/unfollow/[id]/page.tsx");
const DETAIL_VIEW = read("src/app/(app)/relationships/unfollow/[id]/_detail-view.tsx");
const CONTROLS = read("src/app/(app)/relationships/unfollow/[id]/_controls.tsx");
const PANEL = read("src/app/(app)/relationships/_automation-panel.tsx");
const UNFOLLOW_ACTIONS = read("src/app/(app)/relationships/unfollow/_actions.ts");
const FOLLOW_ACTIONS = read("src/app/(app)/relationships/campaigns/_actions.ts");
const MANUAL_ACTIONS = read("src/app/(app)/relationships/_actions.ts");

describe("an unfollow campaign is never described as a follow campaign", () => {
  it("the navigation says Campaigns, not Follow campaigns", () => {
    expect(SIDEBAR).toContain('label: "Campaigns"');
    expect(SIDEBAR).not.toContain("Follow campaigns");
    expect(PAGE).not.toMatch(/title="Follow campaigns"/);
    expect(PAGE).toMatch(/title="Campaigns"/);
  });

  it("every entry in the picker carries its kind, taken from the row", () => {
    expect(UI).toContain('{c.kind === "unfollow" ? "Unfollow" : "Follow"}');
    expect(UI).toContain("data-kind={c.kind}");
  });

  it("an unfollow entry links to its own screen, never to the follow detail", () => {
    expect(UI).toMatch(/c\.kind === "unfollow"\s*\?\s*`\/relationships\/unfollow\/\$\{c\.id\}`/);
  });

  it("the loader never selects an unfollow campaign for the follow detail and tells the page to redirect", () => {
    expect(LOADER).toContain('requested.kind === "unfollow"');
    expect(LOADER).toContain("redirectTo: `/relationships/unfollow/${requested.id}`");
    expect(LOADER).toMatch(/visible\.find\(\(c\) => c\.kind === "follow"\)/);
    expect(PAGE).toContain("if (view.redirectTo) redirect(view.redirectTo);");
  });

  it("offers a filter for each kind and an empty state that names both", () => {
    expect(UI).toContain('data-testid="kind-filter"');
    expect(UI).toMatch(/\["follow", "Follow"\]/);
    expect(UI).toMatch(/\["unfollow", "Unfollow"\]/);
    expect(UI).toContain("No unfollow campaigns yet");
    expect(UI).toContain("No follow campaigns yet");
    expect(UI).toContain("Each campaign is labelled with what it does");
  });

  it("the create form is a FOLLOW form and is not shown on the unfollow filter", () => {
    expect(PAGE).toMatch(/view\.kindFilter !== "unfollow" \? \(\s*<CreateCampaignForm/);
  });
});

describe("/relationships/unfollow/[id] is a dashboard, not a wizard", () => {
  it("imports no setup wizard and no create form", () => {
    for (const src of [DETAIL_PAGE, DETAIL_VIEW]) {
      expect(src).not.toMatch(/_unfollow-wizard|UnfollowWizard|_create-form|CreateCampaignForm|_setup-wizard/);
      // No inputs pretending to edit a created campaign: the only
      // <input>s on the screen are the hidden ids inside control forms.
      expect(src).not.toMatch(/<input[^>]*type="(text|number|time)"/);
      expect(src).not.toMatch(/<select/);
    }
  });

  it("renders the campaign's identity facts: name, identity, status, kind and dry-run badge", () => {
    expect(DETAIL_VIEW).toContain("{d.name}");
    expect(DETAIL_VIEW).toContain("{d.identityLabel}");
    expect(DETAIL_VIEW).toContain('data-testid="campaign-status"');
    expect(DETAIL_VIEW).toContain("Unfollow campaign");
    expect(DETAIL_VIEW).toContain('data-testid="dry-run-badge"');
  });

  it("renders the persisted source, time zone and window, both quotas, and the combined identity usage", () => {
    for (const field of [
      "d.sourceLabel", "d.sourceKind", "d.timezone", "d.windowLabel",
      "d.requestedDailyQuota", "d.effectiveDailyQuota",
      "d.identityMutationsToday", "d.identityCeiling", "d.identityFollowsToday", "d.identityUnfollowsToday",
    ]) {
      expect(DETAIL_VIEW, field).toContain(field);
    }
    expect(DETAIL_VIEW).toMatch(/ceiling is shared by every campaign acting as this account/);
  });

  it("renders every count the operator needs, the percentage and a qualified estimate", () => {
    for (const field of [
      "d.queued", "d.processed", "d.succeeded", "d.alreadyNotFollowing", "d.protectedCount",
      "d.retrying", "d.reconciling", "d.failed", "d.simulated", "d.cancelled", "d.remaining",
      "d.progressPercent", "d.estimatedDays",
    ]) {
      expect(DETAIL_VIEW, field).toContain(field);
    }
    expect(DETAIL_VIEW).toMatch(/An estimate, not a promise/);
  });

  it("renders the next run, the latest run and a keyset-paged run history", () => {
    expect(DETAIL_VIEW).toContain("d.nextRunAt");
    expect(DETAIL_VIEW).toContain('data-testid="latest-run"');
    expect(DETAIL_VIEW).toContain('data-testid="run-history"');
    expect(DETAIL_VIEW).toContain("d.runsNextCursor");
    expect(DETAIL_VIEW).toContain("runs_before: d.runsNextCursor");
  });

  it("renders a keyset-paged member queue with status and an explicit reason on every terminal row", () => {
    expect(DETAIL_VIEW).toContain('data-testid="member-queue"');
    expect(DETAIL_VIEW).toContain("m.reasonLabel");
    expect(DETAIL_VIEW).toContain("after: d.membersNextCursor");
    expect(DETAIL_PAGE).toContain("afterSequence");
    // Paging by sequence, not by page number: no `page=` parameter.
    expect(DETAIL_PAGE).not.toMatch(/searchParams\?\.page\b/);
  });

  it("labels dry-run outcomes as simulated, apart from rejections and skips", () => {
    expect(DETAIL_VIEW).toContain('data-testid="simulated-outcome"');
    expect(DETAIL_VIEW).toContain("Simulated (dry run)");
    expect(DETAIL_VIEW).toMatch(/m\.simulated \? \(/);
    expect(DETAIL_VIEW).toContain('label="Simulated (dry run)"');
  });

  it("offers Pause, Resume, Cancel future work and Reconcile now, and warns that Cancel does not re-follow", () => {
    expect(CONTROLS).toContain('label="Pause now"');
    expect(CONTROLS).toContain('label="Resume"');
    expect(CONTROLS).toContain('label="Cancel future work"');
    expect(CONTROLS).toContain('label="Reconcile now"');
    expect(CONTROLS).toContain("reconcileUnfollowCampaignNowAction");
    expect(DETAIL_VIEW).toMatch(/Cancel does not re-follow anyone already unfollowed/);
    expect(CONTROLS).toMatch(/It does not re-follow anyone already unfollowed/);
  });

  it("every control is a server action that re-establishes the workspace and role itself", () => {
    for (const name of [
      "pauseUnfollowCampaignAction",
      "resumeUnfollowCampaignAction",
      "cancelUnfollowCampaignAction",
      "reconcileUnfollowCampaignNowAction",
      "stopIdentityAction",
      "loadUnfollowActivationFactsAction",
      "activateUnfollowCampaignAction",
    ]) {
      const start = UNFOLLOW_ACTIONS.indexOf(`export async function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const body = UNFOLLOW_ACTIONS.slice(start, start + 800);
      expect(body, `${name} must call requireCtx first`).toMatch(/const ctx = await requireCtx\(\);\s*if \(ctx\.kind !== "ok"\)/);
    }
    expect(UNFOLLOW_ACTIONS).not.toMatch(/formData\.get\("workspace_id"\)/);
  });
});

describe("Reconcile now is a READ", () => {
  it("campaign reconcile actions run the dispatcher with reconcileOnly and nothing else", () => {
    expect(UNFOLLOW_ACTIONS).toMatch(/dispatchUnfollowCampaigns\(\{[\s\S]{0,200}reconcileOnly: true/);
    expect(FOLLOW_ACTIONS).toMatch(/dispatchCampaigns\(\{[\s\S]{0,200}reconcileOnly: true/);
  });

  it("the manual reconcile has no path to a follow or unfollow", () => {
    const start = MANUAL_ACTIONS.indexOf("export async function reconcileNowAction(");
    const end = MANUAL_ACTIONS.indexOf("export async function refreshRelationshipsAction(");
    const body = MANUAL_ACTIONS.slice(start, end);
    expect(body).toContain("requireRelationshipContext(operatorAccountId");
    expect(body).toContain("reconcileUnresolvedActions(");
    expect(body).not.toMatch(/executeFollowAction|executeUnfollowAction|processBatchActions|createFollowRecord|deleteFollowRecord/);
  });

  it("the status panel shows every live campaign with its kind and the shared ceiling", () => {
    expect(PANEL).toMatch(/overview\.campaigns\.map\(/);
    expect(PANEL).toContain('data-testid="shared-ceiling"');
    expect(PANEL).toContain("data-kind={summary.kind}");
    expect(PANEL).not.toMatch(/only campaign|the campaign running/i);
  });
});
