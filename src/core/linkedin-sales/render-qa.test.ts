import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Render harness for the LinkedIn Sales browser sweep.
 *
 * SKIPPED IN CI: it writes an HTML file outside the repository for a
 * Chromium measurement that needs Playwright, which is not a dependency
 * here. Run with RENDER_QA=1 after `npx next build`; the procedure and
 * what it measured are in docs/linkedin-sales/02-browser-qa.md.
 */

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return {
    ...actual,
    useFormState: (_a: unknown, initial: unknown) => [initial, () => undefined],
    useFormStatus: () => ({ pending: false }),
  };
});
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: Record<string, unknown> & { children?: unknown; href?: string }) =>
    ({ type: "a", props: { href, ...rest, children }, key: null, $$typeof: Symbol.for("react.element") }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/linkedin/tasks" }));

describe.skipIf(!process.env.RENDER_QA)("render for the browser sweep", () => {
  it("writes the harness", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = (await import("react")).default;
    const { LinkedInSubnav } = await import("@/app/(app)/linkedin/_subnav");
    const { BoundaryNotice } = await import("@/app/(app)/linkedin/_boundary-notice");
    const { TaskCard } = await import("@/app/(app)/linkedin/tasks/_task-card");
    const { ImportForm } = await import("@/app/(app)/linkedin/leads/_import-form");
    const { LeadListForm } = await import("@/app/(app)/linkedin/leads/_lead-list-form");
    const { SequenceForm } = await import("@/app/(app)/linkedin/sequences/_sequence-form");
    const { CampaignForm } = await import("@/app/(app)/linkedin/campaigns/_campaign-form");
    const { CampaignControls } = await import("@/app/(app)/linkedin/campaigns/_campaign-controls");

    // DELIBERATELY HOSTILE CONTENT: a 214-character unbreakable profile
    // slug, a 60-character name with no spaces, a 4,000-character draft
    // with one 300-character word, and a 33-character timezone.
    const HOSTILE_SLUG = "a".repeat(120) + "-" + "b".repeat(93);
    const HOSTILE_URL = `https://www.linkedin.com/in/${HOSTILE_SLUG}`;
    const HOSTILE_NAME = "Maximilianus-Bartholomew-Fitzgerald-Montgomery-Wellington-Jr";
    const HOSTILE_DRAFT = ("Hello " + HOSTILE_NAME + ", " + "w".repeat(300) + " ").repeat(9).slice(0, 4000);

    const html = renderToStaticMarkup(
      React.createElement(
        "div",
        { className: "px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-5xl space-y-6" },
        React.createElement(LinkedInSubnav),
        React.createElement(BoundaryNotice),
        React.createElement(TaskCard, {
          task: { id: "t1", kind: "manual_linkedin_message", state: "opened", draftText: HOSTILE_DRAFT, profileUrl: HOSTILE_URL, openedAt: "2026-09-16T10:00:00Z", copiedAt: null },
          lead: { name: HOSTILE_NAME, company: "Acme-Consolidated-Industries-International-Holdings-Limited", title: "Chief-Executive-Officer-and-Founder" },
          campaignName: "Q4 enterprise re-engagement campaign with a deliberately long name that wraps",
          canEdit: true,
        }),
        React.createElement(TaskCard, {
          task: { id: "t2", kind: "manual_profile_review", state: "ready", draftText: null, profileUrl: "https://www.linkedin.com/in/short", openedAt: null, copiedAt: null },
          lead: { name: null, company: null, title: null },
          campaignName: "Short",
          canEdit: true,
        }),
        React.createElement(LeadListForm),
        React.createElement(ImportForm, { leadListId: "00000000-0000-4000-8000-000000000000", defaultSourceType: "customer_csv" }),
        React.createElement(SequenceForm),
        React.createElement(CampaignForm, {
          lists: [{ id: "l1", name: "A list with a rather long name for the select control" }],
          sequences: [{ id: "s1", name: "Sequence" }],
          defaultTimezone: "America/Argentina/ComodRivadavia",
        }),
        React.createElement(CampaignControls, { campaignId: "c1", status: "active", name: "Q4 enterprise re-engagement campaign with a deliberately long name" }),
        React.createElement(CampaignControls, { campaignId: "c2", status: "draft", name: "Draft" }),
      ),
    );

    const cssDir = path.join(process.cwd(), ".next", "static", "css");
    const css = readdirSync(cssDir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(path.join(cssDir, f), "utf8"))
      .join("\n");
    expect(css.length).toBeGreaterThan(10_000);

    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body>${html}<script>document.querySelectorAll('dialog').forEach(d=>d.show());document.querySelectorAll('details').forEach(d=>d.open=true);</script></body></html>`;
    const outDir = "/tmp/linkedin-qa";
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "index.html"), page);
    expect(html).toContain(HOSTILE_URL);
  });
});
