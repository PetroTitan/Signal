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
// Run with RENDER_QA=1 to regenerate it — the procedure and what it
// measured are in docs/relationships/unfollow-browser-qa.md.
describe.skipIf(!process.env.RENDER_QA)("render for the browser sweep", () => {
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
    const { UnfollowCampaignDetailView } = await import(
      "@/app/(app)/relationships/unfollow/[id]/_detail-view"
    );
    const { CampaignUi } = await import(
      "@/app/(app)/relationships/campaigns/_campaign-ui"
    );
    const { AutomationPanel } = await import(
      "@/app/(app)/relationships/_automation-panel"
    );

    // DELIBERATELY HOSTILE CONTENT. A 45-character unbreakable handle,
    // a full DID, a long name and six-figure counts are what actually
    // push a flex row past 320px.
    const HOSTILE_HANDLE = "averyveryverylongunbreakablehandle-example.bsky.social";
    const HOSTILE_DID = "did:plc:z72i7hdynmk6r22z27h6tvurabcdefghij";

    const hostileDetail = {
      id: "c1",
      kind: "unfollow" as const,
      name: "An unfollow campaign with an extremely long name that will not wrap nicely at all",
      status: "active" as const,
      dryRun: true,
      identityLabel: `@${HOSTILE_HANDLE}`,
      identityHandle: HOSTILE_HANDLE,
      identityId: "i1",
      sourceKind: "target_followers",
      sourceLabel: "An imported list",
      sourceTargetLabel: `@${HOSTILE_HANDLE}`,
      sourceFrozen: true,
      queueSize: 123456,
      allowlistCount: 1234,
      requestedDailyQuota: 1000,
      effectiveDailyQuota: 400,
      effectiveQuotaReason:
        "Reduced to 400 a day: this account's daily allowance is shared with a follow campaign that has already used 600 actions today.",
      timezone: "America/Argentina/ComodRivadavia",
      windowLabel: "09:00–20:00",
      windowStartMinute: 540,
      windowEndMinute: 1200,
      todayAttempted: 123456, todaySucceeded: 123456, todayAlreadyAbsent: 123456,
      todayProtected: 123456, todayFailed: 123456, todayReconciliationRequired: 123456,
      queued: 123456, inProgress: 123456, processed: 123456, succeeded: 123456,
      alreadyNotFollowing: 123456, protectedCount: 123456, retrying: 123456,
      reconciling: 123456, failed: 123456, simulated: 123456,
      skippedByReason: { actor_not_found: 123456, no_record_target: 123456 },
      cancelled: 123456, remaining: 123456, total: 123456, progressPercent: 57,
      lastSuccessAt: "2026-09-16T12:00:00Z",
      nextRunAt: "2026-09-17T09:00:00Z",
      rateLimitedUntil: null,
      lastErrorMessage:
        "A provider error message that is long enough to need wrapping on a narrow phone and contains no whitespace: " +
        "record/subject/must/be/a/valid/did/record/subject/must/be/a/valid/did",
      identityFollowsToday: 600, identityUnfollowsToday: 400, identityMutationsToday: 1000,
      identityCeiling: 1000, identityPointsToday: 2200,
      estimatedDays: 306,
      latestRun: {
        id: "r1", localDate: "2026-09-16", status: "running", attempted: 123456, succeeded: 123456,
        alreadyAbsent: 123456, protectedCount: 123456, failed: 123456, reconciliationRequired: 123456,
        effectiveDailyQuota: 400, effectiveQuotaReason: "shared allowance", lastChunkAt: null, lastErrorMessage: null,
      },
      runs: Array.from({ length: 3 }, (_, i) => ({
        id: `r${i}`, localDate: `2026-09-1${i}`, status: "completed", attempted: 123456, succeeded: 123456,
        alreadyAbsent: 123456, protectedCount: 123456, failed: 123456, reconciliationRequired: 123456,
        effectiveDailyQuota: 400, effectiveQuotaReason: null, lastChunkAt: null, lastErrorMessage: null,
      })),
      runsNextCursor: "2026-09-10",
      members: [
        { id: "m1", sequence: 1, subjectDid: HOSTILE_DID, handle: HOSTILE_HANDLE, status: "skipped", simulated: true,
          reasonCode: "dry_run", reasonLabel: "Simulated (dry run) — nothing was sent to Bluesky.", protectedReason: null,
          recordRkey: "rk", recordSource: "list_records", lastErrorMessage: null, attemptCount: 1, nextAttemptAt: null, completedAt: null },
        { id: "m2", sequence: 2, subjectDid: HOSTILE_DID, handle: null, status: "retryable", simulated: false,
          reasonCode: null, reasonLabel: null, protectedReason: null, recordRkey: null, recordSource: null,
          lastErrorMessage: "socket hang up socket hang up socket hang up socket hang up socket hang up", attemptCount: 3,
          nextAttemptAt: "2026-09-16T13:00:00Z", completedAt: null },
        { id: "m3", sequence: 3, subjectDid: HOSTILE_DID, handle: HOSTILE_HANDLE, status: "protected", simulated: false,
          reasonCode: "protected", reasonLabel: "Protected: a reason that is quite long and explains exactly why this profile must never be unfollowed by anything",
          protectedReason: "long", recordRkey: null, recordSource: null, lastErrorMessage: null, attemptCount: 0, nextAttemptAt: null, completedAt: null },
      ],
      membersNextCursor: 3,
      memberFilter: null,
    };

    const html = [
      `<section id="qa-detail">` +
        renderToStaticMarkup(
          React.createElement(UnfollowCampaignDetailView, { detail: hostileDetail, canManage: true }),
        ) +
        `</section>`,
      `<section id="qa-campaigns">` +
        renderToStaticMarkup(
          React.createElement(CampaignUi, {
            identities: [{ id: "i1", handle: HOSTILE_HANDLE, displayName: null }],
            campaigns: [
              { id: "f1", kind: "follow", name: "A follow campaign with an extremely long name indeed", status: "active" },
              { id: "u1", kind: "unfollow", name: "An unfollow campaign with an extremely long name indeed", status: "rate_limited" },
            ] as never,
            kindFilter: "all",
            detail: null,
            killSwitches: [],
          }),
        ) +
        `</section>`,
      `<section id="qa-panel">` +
        renderToStaticMarkup(
          React.createElement(AutomationPanel, {
            overview: {
              identityId: "i1", identityHandle: HOSTILE_HANDLE, identityDisplayName: "A Very Long Display Name",
              followsToday: 600, unfollowsToday: 400, attemptsToday: 1000, ceiling: 1000, otherIdentitiesLive: 2,
              campaigns: [
                { id: "f1", kind: "follow", name: "A follow campaign with an extremely long name indeed", status: "active",
                  identityId: "i1", identityHandle: HOSTILE_HANDLE, identityDisplayName: null, completed: 123456, total: 234567,
                  attemptedToday: 123456, succeededToday: 123456, failedToday: 123456, requestedDailyQuota: 1000,
                  effectiveDailyQuota: 400, effectiveQuotaReason: "Reduced to 400 a day: this account's daily allowance is shared.",
                  nextRunAt: "2026-09-17T09:00:00Z", dryRun: false, href: "/relationships/campaigns?campaign=f1" },
                { id: "u1", kind: "unfollow", name: "An unfollow campaign with an extremely long name indeed", status: "reauthorization_required",
                  identityId: "i1", identityHandle: HOSTILE_HANDLE, identityDisplayName: null, completed: 1, total: 234567,
                  attemptedToday: 0, succeededToday: 0, failedToday: 0, requestedDailyQuota: 300,
                  effectiveDailyQuota: 0, effectiveQuotaReason: null, nextRunAt: null, dryRun: true, href: "/relationships/unfollow/u1" },
              ],
            },
          }),
        ) +
        `</section>`,
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
              allowlistCount: 1234,
              version: "0123456789abcdef0123456789abcdef",
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
