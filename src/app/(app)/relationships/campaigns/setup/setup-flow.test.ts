import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { can } from "@/core/teams/permissions";
import { AUTHENTICATED_ROUTES } from "@/core/navigation/route-manifest";
import { DAILY_QUOTA_OPTIONS } from "@/core/bluesky-campaigns/quota";

/**
 * The setup flow: what it offers, what it gates, and what it cannot do.
 *
 * Structural assertions over the modules rather than invocations, for
 * the reason the sibling authorization suite states: the actions call
 * `createSupabaseServerClient` and `getPrimaryWorkspace`, which need a
 * Next request scope vitest does not have, and mocking those away would
 * mock away the thing under test.
 *
 * The behaviour that CAN be executed — the import itself — is covered
 * against a fake database in `resumable-import.test.ts` and against a
 * real PostgreSQL server in `src/test/pg/setup-and-import.pg.test.ts`.
 */

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/**
 * Strip comments before matching.
 *
 * Every content assertion below would otherwise fire on the modules'
 * own prose — which explains the very defects being guarded — and a
 * control that fails on the sentence describing the invariant pressures
 * the next person to delete the explanation.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const SETUP_ACTIONS = code(
  read("src/app/(app)/relationships/campaigns/setup/_actions.ts"),
);
const WIZARD = code(
  read("src/app/(app)/relationships/campaigns/setup/_setup-wizard.tsx"),
);
const RELATIONSHIPS_PAGE = code(read("src/app/(app)/relationships/page.tsx"));
const PANEL = code(read("src/app/(app)/relationships/_automation-panel.tsx"));
const CAMPAIGN_ACTIONS = code(
  read("src/app/(app)/relationships/campaigns/_actions.ts"),
);

// =====================================================================
// The call to action
// =====================================================================

describe("starting automatic following is reachable from the main page", () => {
  it("renders a primary CTA on the Relationships page", () => {
    expect(PANEL).toContain("Start automatic following");
    expect(PANEL).toContain("/relationships/campaigns/setup");
    expect(RELATIONSHIPS_PAGE).toContain("StartAutomationCta");
  });

  it("puts it in the page header, so it is on screen at every width", () => {
    // The Topbar's `actions` slot renders beside the title on desktop
    // and wraps beneath it on a narrow screen. Both are the page
    // itself — neither is behind the More sheet, which is where the
    // only route to this capability used to live on mobile.
    // The page renders several Topbars (unconfigured, no workspace, the
    // real one); the CTA must be inside the `actions` slot of one that
    // actually shows the relationship surface.
    const headers = [...RELATIONSHIPS_PAGE.matchAll(/<Topbar[\s\S]*?\/>/g)].map(
      (m) => m[0],
    );
    expect(headers.length).toBeGreaterThan(0);
    const withCta = headers.filter((h) => h.includes("StartAutomationCta"));
    expect(withCta).toHaveLength(1);
    expect(withCta[0]).toContain("actions=");
  });

  it("does not require opening secondary navigation", () => {
    // No `sm:hidden` / `hidden` wrapper may gate the CTA, and it must
    // not be rendered only inside a menu component.
    const cta = PANEL.slice(PANEL.indexOf("export function StartAutomationCta"));
    expect(cta).not.toMatch(/\bhidden\b/);
    expect(cta).not.toMatch(/MoreSheet|NavSheet|Drawer/);
  });

  it("is hidden from a role that could not complete it", () => {
    expect(PANEL).toContain("if (!canManage) return null");
    expect(RELATIONSHIPS_PAGE).toContain('can(membership.role, "connect_platforms")');
  });

  it("no longer claims nothing runs on its own", () => {
    // The page said so while a campaign could be following people all
    // day.
    expect(RELATIONSHIPS_PAGE).not.toContain("Nothing here runs on its own");
  });

  it("distinguishes manual actions from the automatic campaign", () => {
    expect(RELATIONSHIPS_PAGE).toContain("only the profiles you");
    expect(RELATIONSHIPS_PAGE).toMatch(/until the whole list is done/i);
  });
});

// =====================================================================
// The status panel
// =====================================================================

describe("the campaign status panel", () => {
  const SUMMARY = code(
    read("src/core/bluesky-campaigns/load-campaign-summary.server.ts"),
  );

  it("shows everything the operator needs without opening the campaign", () => {
    for (const field of [
      "summary.name",
      "identity",
      "summary.completed",
      "summary.total",
      "summary.attemptedToday",
      "summary.succeededToday",
      "summary.requestedDailyQuota",
      "summary.effectiveDailyQuota",
      "summary.nextRunAt",
    ]) {
      expect(PANEL, field).toContain(field);
    }
    expect(PANEL).toContain("View campaign");
    expect(PANEL).toContain("Pause");
  });

  it("reports requested and effective quota as different numbers", () => {
    // The requested amount is not a promise, and a panel that showed
    // one number would be claiming it was.
    expect(PANEL).toContain("You asked for");
    expect(PANEL).toContain("Today&apos;s limit");
    expect(PANEL).toContain("summary.effectiveQuotaReason");
  });

  it("does NOT load the queue to render a summary", () => {
    // A campaign may hold 100,000 members. The panel is a header.
    expect(SUMMARY).not.toContain("loadCampaigns");
    expect(SUMMARY).not.toContain("listCampaignMembersPage");
    expect(SUMMARY).toContain("countMembersByStatus");
  });

  it("says plainly when the campaign is finished", () => {
    expect(PANEL).toMatch(/will not follow anyone else/i);
  });

  it("does not make Pause look like a destructive stop", () => {
    // Pause is secondary here and stopping for good is not offered at
    // all — it lives on the campaign page with its own confirmation.
    const controls = PANEL.slice(PANEL.indexOf("View campaign"));
    expect(controls).toContain("btn-secondary");
    expect(controls).not.toMatch(/\bCancel campaign\b|\bStop\b|\bDelete\b/);
  });
});

// =====================================================================
// Quota
// =====================================================================

describe("the daily amount offered by the UI", () => {
  it("offers every 100 from 100 to 1,000", () => {
    expect([...DAILY_QUOTA_OPTIONS]).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ]);
  });

  it("300 is selectable", () => {
    expect(DAILY_QUOTA_OPTIONS).toContain(300);
  });

  it("the wizard renders the shared set rather than its own list", () => {
    // A hardcoded list in the form is how the UI and the database
    // drifted apart in the first place.
    expect(WIZARD).toContain("DAILY_QUOTA_OPTIONS.map");
    expect(WIZARD).not.toMatch(/\[100,\s*200,\s*400/);
  });

  it("the server validates against the closed set", () => {
    expect(SETUP_ACTIONS).toContain("isDailyQuota(quotaRaw)");
  });
});

// =====================================================================
// Zero provider mutations before the final confirmation
// =====================================================================

describe("nothing reaches Bluesky before the operator confirms", () => {
  it("the setup actions never call a follow mutation", () => {
    for (const forbidden of [
      "createFollowRecord",
      "deleteFollowRecord",
      "applyFollow",
      "executeBatch",
    ]) {
      expect(SETUP_ACTIONS, forbidden).not.toContain(forbidden);
    }
  });

  it("the wizard never calls a provider directly", () => {
    expect(WIZARD).not.toContain("fetch(");
    expect(WIZARD).not.toContain("createFollowRecord");
    expect(WIZARD).not.toContain("bsky.social");
  });

  it("creating the draft and building the queue are database-only", () => {
    // The only provider read in the import path is the follower walk,
    // and that is a READ — it is in the import module, not here.
    const start = SETUP_ACTIONS.slice(
      SETUP_ACTIONS.indexOf("export async function startCampaignSetupAction"),
    );
    expect(start).toContain("createCampaign");
    expect(start).toContain("resumeCampaignImport");
    expect(start).not.toContain("createFollowRecord");
  });

  it("cancel is a plain link away, with no action attached", () => {
    const cancel = WIZARD.slice(WIZARD.indexOf("Cancel"));
    expect(WIZARD).toContain('href="/relationships"');
    expect(cancel).not.toContain("onClick={() => activate");
  });

  it("activation requires an explicit confirmation value", () => {
    expect(SETUP_ACTIONS).toContain('formData.get("confirm") ?? ""');
    expect(SETUP_ACTIONS).toContain('!== "start"');
    expect(WIZARD).toContain('name="confirm" value="start"');
  });
});

// =====================================================================
// A partly-built queue cannot be started
// =====================================================================

describe("activation refuses an unfinished list", () => {
  it("checks the import job before activating, in the setup flow", () => {
    const activate = SETUP_ACTIONS.slice(
      SETUP_ACTIONS.indexOf("export async function activateFromSetupAction"),
    );
    expect(activate).toContain("getImportJob");
    expect(activate).toContain("sourceExhausted");
    expect(activate).toContain('job.status === "failed"');
  });

  it("checks it in the older campaign flow too", () => {
    // Both doors, or the guard is decorative.
    const activate = CAMPAIGN_ACTIONS.slice(
      CAMPAIGN_ACTIONS.indexOf("export async function activateCampaignAction"),
    );
    expect(activate).toContain("getImportJob");
    expect(activate).toContain("sourceExhausted");
  });

  it("refuses an empty queue", () => {
    expect(SETUP_ACTIONS).toContain("counts.total === 0");
  });

  it("the Start button is disabled until the list is ready", () => {
    expect(WIZARD).toContain("disabled={!ready}");
  });
});

// =====================================================================
// Import progress is the database's, not the browser's
// =====================================================================

describe("import progress is never supplied by the client", () => {
  it("no action reads a page number from the form", () => {
    for (const source of [SETUP_ACTIONS, CAMPAIGN_ACTIONS]) {
      expect(source).not.toContain('formData.get("start_page")');
      expect(source).not.toContain("startPage");
    }
  });

  it("the wizard submits only the campaign id to continue", () => {
    const cont = WIZARD.slice(WIZARD.indexOf("action={continueAction}"));
    expect(cont).toContain('name="campaign_id"');
    expect(cont).not.toContain('name="start_page"');
    expect(cont).not.toContain('name="cursor"');
  });

  it("the import driver never uses OFFSET paging", () => {
    const DRIVER = code(
      read("src/core/bluesky-campaigns/resume-import.server.ts"),
    );
    expect(DRIVER).not.toContain("listCandidatesPage");
    expect(DRIVER).not.toMatch(/\bpage:\s*\w/);
    expect(DRIVER).toContain("listCandidatesKeyset");
  });

  it("shows importing / ready / failed and whether the source is consumed", () => {
    expect(WIZARD).toMatch(/Building the list/);
    expect(WIZARD).toMatch(/Ready —/);
    expect(WIZARD).toMatch(/could not be finished/);
    expect(WIZARD).toContain("Already queued");
    expect(WIZARD).toContain("Skipped — private");
  });

  it("tells the operator they may leave and come back", () => {
    expect(WIZARD).toMatch(/leave this page and come\s+back/);
  });

  it("persists the created campaign id in the URL for reload recovery", () => {
    expect(WIZARD).toContain("window.history.replaceState");
    expect(WIZARD).toContain("?campaign=");
    const page = code(
      read("src/app/(app)/relationships/campaigns/setup/page.tsx"),
    );
    expect(page).toContain("searchParams?.campaign");
    expect(page).toContain("/relationships/campaigns?campaign=");
  });
});

// =====================================================================
// Authorization
// =====================================================================

describe("who may set up automatic following", () => {
  it("owner and admin may; editor, reviewer and viewer may not", () => {
    expect(can("owner", "connect_platforms")).toBe(true);
    expect(can("admin", "connect_platforms")).toBe(true);
    for (const role of ["editor", "reviewer", "viewer"] as const) {
      expect(can(role, "connect_platforms"), role).toBe(false);
    }
  });

  it("every setup action runs the context gate", () => {
    const actions = [
      ...SETUP_ACTIONS.matchAll(/export async function (\w+Action)\(/g),
    ].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(0);
    for (const name of actions) {
      const start = SETUP_ACTIONS.indexOf(`export async function ${name}(`);
      const next = SETUP_ACTIONS.indexOf("\nexport ", start + 1);
      const body = SETUP_ACTIONS.slice(
        start,
        next > 0 ? next : SETUP_ACTIONS.length,
      );
      expect(body, `${name} must call requireCtx`).toContain("await requireCtx()");
      expect(body, `${name} must bail on failure`).toContain('ctx.kind !== "ok"');
    }
  });

  it("uses service-role only after the user/workspace permission gate", () => {
    for (const name of [
      "previewSourceAction",
      "startCampaignSetupAction",
      "continueImportAction",
      "activateFromSetupAction",
    ]) {
      const start = SETUP_ACTIONS.indexOf(`export async function ${name}(`);
      const next = SETUP_ACTIONS.indexOf("\nexport ", start + 1);
      const body = SETUP_ACTIONS.slice(
        start,
        next > 0 ? next : SETUP_ACTIONS.length,
      );
      expect(body, name).toContain("await requireCtx()");
      const gateAt = body.indexOf('ctx.kind !== "ok"');
      const serviceAt = body.indexOf("requireCampaignServiceDb()");
      expect(serviceAt, name).toBeGreaterThan(gateAt);
    }
  });

  it("the gate checks sign-in, workspace and permission", () => {
    const gate = SETUP_ACTIONS.slice(
      SETUP_ACTIONS.indexOf("async function requireCtx"),
    );
    expect(gate).toContain("auth.getUser()");
    expect(gate).toContain("getPrimaryWorkspace()");
    expect(gate).toContain('can(membership.role, "connect_platforms")');
  });

  it("every query is scoped to the caller's workspace", () => {
    // Cross-workspace isolation: nothing may be looked up by id alone.
    expect(SETUP_ACTIONS).not.toMatch(/getCampaign\(\s*campaignId/);
    expect(SETUP_ACTIONS).toMatch(/getCampaign\(ctx\.workspaceId, campaignId\)/);
  });

  it("the route is registered with the same permission", () => {
    const route = AUTHENTICATED_ROUTES.find(
      (r) => r.href === "/relationships/campaigns/setup",
    );
    expect(route).toBeTruthy();
    expect(route?.permission).toBe("connect_platforms");
  });
});

// =====================================================================
// Mobile
// =====================================================================

describe("usable on a 320px screen", () => {
  /**
   * Class-token proxies, not layout measurements — the honest limit the
   * sibling mobile suite states for itself. A node test cannot measure
   * an overflow; what it can do is make the specific defect that causes
   * one unrepresentable. The real-browser sweep is recorded separately.
   */
  it("interactive targets are at least 44px", () => {
    for (const source of [WIZARD, PANEL]) {
      const controls = [...source.matchAll(/className="[^"]*btn-(primary|secondary)[^"]*"/g)];
      expect(controls.length).toBeGreaterThan(0);
      for (const c of controls) {
        expect(c[0], c[0]).toMatch(/min-h-11/);
      }
    }
  });

  it("form controls are at least 44px too", () => {
    const inputs = [...WIZARD.matchAll(/className="input[^"]*"/g)];
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i[0], i[0]).toMatch(/min-h-11/);
  });

  it("long handles and names cannot push the layout sideways", () => {
    // A flex child defaults to min-width:auto and refuses to shrink
    // below its content — one unbreakable handle then scrolls the whole
    // page. Both halves of the fix must be present.
    expect(PANEL).toContain("min-w-0");
    expect(PANEL).toContain("break-words");
    expect(WIZARD).toContain("min-w-0");
    expect(WIZARD).toContain("break-words");
  });

  it("no horizontal scroll container is introduced at page level", () => {
    for (const source of [WIZARD, PANEL]) {
      expect(source).not.toContain("overflow-x-auto");
      expect(source).not.toContain("w-screen");
      expect(source).not.toMatch(/\bmin-w-\[\d/);
    }
  });

  it("multi-column grids collapse to one column first", () => {
    // `grid-cols-2` without a breakpoint prefix is a two-column layout
    // at 320px.
    for (const source of [WIZARD, PANEL]) {
      const grids = [...source.matchAll(/className="[^"]*\bgrid\b[^"]*"/g)];
      for (const g of grids) {
        if (/\bgrid-cols-[3-9]\b/.test(g[0])) {
          expect(g[0], g[0]).toMatch(/\bsm:|md:|lg:/);
        }
      }
    }
  });
});
