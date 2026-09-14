import { describe, it, expect, vi } from "vitest";
import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Renders the real unfollow components into a static page carrying the
 * REAL compiled stylesheet, for the Chromium sweep. Not a behavioural
 * test — it exists so the measurement is taken against shipped classes
 * rather than a hand-written approximation.
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

// SKIPPED IN CI. This writes an HTML file outside the repository for a
// Chromium sweep that needs Playwright, which is not a dependency here.
// Remove the `.skip` to regenerate it — the procedure and what it
// measured are in docs/relationships/unfollow-browser-qa.md.
describe.skip("render for the browser sweep", () => {
  it("writes the harness", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const React = (await import("react")).default;
    const { UnfollowWizard } = await import(
      "@/app/(app)/relationships/unfollow/_unfollow-wizard"
    );
    const { ConfirmActivationDialog } = await import(
      "@/app/(app)/relationships/unfollow/_confirm-activation"
    );
    const { AllowlistPanel } = await import(
      "@/app/(app)/relationships/unfollow/_allowlist-panel"
    );
    const { CampaignControls } = await import(
      "@/app/(app)/relationships/unfollow/[id]/_controls"
    );

    // DELIBERATELY HOSTILE CONTENT. A 45-character unbreakable handle,
    // a full DID, a long name and six-figure counts are what actually
    // push a flex row past 320px.
    const HOSTILE_HANDLE = "averyveryverylongunbreakablehandle-example.bsky.social";
    const HOSTILE_DID = "did:plc:z72i7hdynmk6r22z27h6tvurabcdefghij";

    const html = [
      renderToStaticMarkup(
        React.createElement(UnfollowWizard, {
          identities: [
            { id: "i1", handle: HOSTILE_HANDLE, displayName: "A Very Long Display Name That Will Not Wrap Nicely" },
          ],
          targets: [
            { id: "t1", handle: HOSTILE_HANDLE, displayName: null, candidateCount: 123456 },
          ],
          followCampaigns: [{ id: "c1", name: "A follow campaign with an extremely long name indeed", succeeded: 123456 }],
          defaultTimezone: "UTC",
          canManage: true,
        }),
      ),
      renderToStaticMarkup(
        React.createElement(AllowlistPanel, {
          entries: [
            {
              id: "a1",
              subjectDid: HOSTILE_DID,
              subjectHandle: HOSTILE_HANDLE,
              operatorAccountId: null,
              reason: "A reason that is quite long and explains exactly why this profile must never be unfollowed by anything",
              createdAt: "2026-09-14T00:00:00Z",
            },
          ],
          identities: [{ id: "i1", handle: HOSTILE_HANDLE }],
          canManage: true,
        }),
      ),
      renderToStaticMarkup(
        React.createElement(CampaignControls, {
          campaignId: "c1",
          identityId: "i1",
          identityLabel: `@${HOSTILE_HANDLE}`,
          status: "active",
          canManage: true,
        }),
      ),
      `<div id="dialog-host">` +
        renderToStaticMarkup(
          React.createElement(ConfirmActivationDialog, {
            facts: {
              campaignId: "c1",
              actorLabel: `@${HOSTILE_HANDLE}`,
              actorHandle: HOSTILE_HANDLE,
              sourceLabel: "Everyone this account currently follows",
              discovered: 123456,
              stillBuilding: false,
              protectedExcluded: 1234,
              remainingEligible: 122222,
              requestedDailyQuota: 1000,
              effectiveDailyQuota: 400,
              effectiveQuotaReason:
                "Reduced to 400 a day: this account's daily allowance is shared with a follow campaign that has already used 600 actions today.",
              timezone: "America/Argentina/ComodRivadavia",
              windowLabel: "09:00–20:00",
              estimatedDays: 306,
              dryRun: true,
            },
            dispatch: () => undefined,
            onCancel: () => undefined,
            result: null,
          }),
        ) +
        `</div>`,
    ].join("\n");

    const cssDir = path.join(process.cwd(), ".next/static/css");
    const css = readdirSync(cssDir)
      .filter((f) => f.endsWith(".css"))
      .map((f) => readFileSync(path.join(cssDir, f), "utf8"))
      .join("\n");

    writeFileSync(
      "/tmp/unfollow-qa/index.html",
      `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<style>body{margin:0}</style>
</head><body class="bg-white">
<main class="px-4 sm:px-6 lg:px-10 py-6 sm:py-8 max-w-4xl space-y-6">${html}</main>
</body></html>`,
    );
    expect(html.length).toBeGreaterThan(1000);
  });
});
