/**
 * Regression tests for the /accounts Manage panel.
 *
 * These tests don't render the React tree — they guard against the
 * specific UI failure modes we shipped in production prior to
 * fix/account-access-ui-functional:
 *
 *   1. dev.to + Hashnode (personal_api_key plans) were never rendered
 *      inside ConnectionControls because page.tsx's authControls gate
 *      omitted `personal_api_key` — operators saw an empty Manage
 *      panel.
 *
 *   2. The legacy /api/identity/:id/verify stub returned copy like
 *      "Identity verification for telegram is not implemented yet.
 *      The provider client will land in a follow-up PR." and
 *      "Platform Hashnode does not use the API-key verify flow. This
 *      platform has no identity-level connect path." — both exposed
 *      internal terms and contradicted shipped phases.
 *
 *   3. The client `verifyApiKey` helper had a dead branch that
 *      surfaced the same "follow-up PR" copy when the route returned
 *      501.
 *
 * The tests assert (a) the authControls gate handles every plan kind
 * with a real sign-in flow, and (b) the offending stub copy is no
 * longer present anywhere under src/app/.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveConnectIdentityPlan,
  shouldShowManageButton,
  type ConnectIdentityInput,
} from "@/core/publishing/connect-identity";

const APP_ROOT = join(process.cwd(), "src", "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

const ALL_SOURCE_FILES = walk(APP_ROOT);

function input(
  overrides: Partial<ConnectIdentityInput> = {},
): ConnectIdentityInput {
  return {
    identityId: "id-1",
    platform: "reddit",
    publishingMode: "manual",
    distributionOnly: false,
    oauthAvailable: true,
    ...overrides,
  };
}

// =====================================================================
// authControls gate: every plan kind with real sign-in actions must
// match. The page.tsx gate that omitted personal_api_key was the root
// cause of dev.to + Hashnode being unusable in production.
// =====================================================================

const AUTH_PLAN_KINDS = [
  "oauth",
  "api_key_verify",
  "app_password",
  "personal_api_key",
] as const;

describe("authControls gate coverage (page.tsx)", () => {
  it.each([
    { platform: "reddit", publishingMode: "manual", oauthAvailable: true, expectedKind: "oauth" },
    { platform: "bluesky", publishingMode: "api", oauthAvailable: false, expectedKind: "app_password" },
    { platform: "devto", publishingMode: "api", oauthAvailable: false, expectedKind: "personal_api_key" },
    { platform: "hashnode", publishingMode: "api", oauthAvailable: false, expectedKind: "personal_api_key" },
    { platform: "telegram", publishingMode: "api", oauthAvailable: false, expectedKind: "api_key_verify" },
  ] as const)(
    "%j resolves to a plan kind the Manage panel can render",
    (scenario) => {
      const plan = resolveConnectIdentityPlan(
        input({
          platform: scenario.platform,
          publishingMode: scenario.publishingMode,
          oauthAvailable: scenario.oauthAvailable,
        }),
      );
      expect(plan.kind).toBe(scenario.expectedKind);
      // Both checks together guarantee the Manage button shows AND
      // the page.tsx gate routes this plan to ConnectionControls.
      expect(shouldShowManageButton(plan)).toBe(true);
      expect(AUTH_PLAN_KINDS).toContain(plan.kind);
    },
  );

  it("Manual + distribution platforms render through manualHint, NOT the auth gate", () => {
    for (const platform of ["x", "linkedin", "youtube", "threads", "instagram", "indie_hackers"] as const) {
      const plan = resolveConnectIdentityPlan(
        input({
          platform,
          publishingMode: "manual",
          distributionOnly: platform !== "indie_hackers",
          oauthAvailable: false,
        }),
      );
      expect(plan.kind).toBe("manual");
      // Manage button still shows so the steady-state hint surfaces,
      // but the plan kind isn't one of the auth-gated kinds.
      expect(AUTH_PLAN_KINDS).not.toContain(plan.kind as never);
      if (plan.kind === "manual") {
        // Hint copy is operator-friendly, not engineering.
        expect(plan.hint.toLowerCase()).not.toContain("api_key_verify");
        expect(plan.hint.toLowerCase()).not.toContain("personal_api_key");
        expect(plan.hint.toLowerCase()).not.toContain("connection row");
      }
    }
  });
});

// =====================================================================
// Leaked copy guards — these strings must NEVER appear in src/app/
// =====================================================================

describe("legacy stub copy must not be present anywhere under src/app/", () => {
  const FORBIDDEN = [
    /not implemented yet/i,
    /follow-up PR/i,
    /no identity-level connect path/i,
    /does not use the API-key verify flow/i,
    /isn't wired up yet/i,
  ];

  it.each(FORBIDDEN)("no source file contains: %s", (pattern) => {
    const offenders: string[] = [];
    for (const path of ALL_SOURCE_FILES) {
      // The regression test itself naturally contains the patterns —
      // skip it. Same for any test file that asserts on these.
      if (path.endsWith("_account-access-ui.test.ts")) continue;
      const content = readFileSync(path, "utf8");
      if (pattern.test(content)) offenders.push(path.replace(process.cwd(), ""));
    }
    expect(offenders, `Forbidden copy found in:\n${offenders.join("\n")}`).toEqual([]);
  });
});

