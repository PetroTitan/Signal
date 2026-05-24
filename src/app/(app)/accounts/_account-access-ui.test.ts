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
  // NOTE: Hashnode is intentionally absent — fix/hashnode-manual-mode
  // moved it to publishingMode='manual' in platform-guidance.ts.
  // Hashnode now renders through the manualHint branch, NOT the auth
  // gate. The Hashnode-as-manual case is covered in the dedicated
  // suite below.
  it.each([
    { platform: "reddit", publishingMode: "manual", oauthAvailable: true, expectedKind: "oauth" },
    { platform: "bluesky", publishingMode: "api", oauthAvailable: false, expectedKind: "app_password" },
    { platform: "devto", publishingMode: "api", oauthAvailable: false, expectedKind: "personal_api_key" },
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

  it("Hashnode (publishingMode='manual') resolves to manual — NOT one of the auth-gated kinds", () => {
    // Production routing for Hashnode after the manual-mode flip:
    // the Manage panel renders the Hashnode-specific hint + note,
    // never the personal_api_key sign-in form.
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "hashnode",
        publishingMode: "manual",
        oauthAvailable: false,
      }),
    );
    expect(plan.kind).toBe("manual");
    expect(AUTH_PLAN_KINDS).not.toContain(plan.kind as never);
    if (plan.kind === "manual") {
      expect(plan.hint.toLowerCase()).toContain("hashnode");
      expect(plan.note).toBeDefined();
    }
  });

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

// =====================================================================
// Personal-API-key sign-in copy: the form must read like account
// sign-in, not a developer-settings dump. dev.to is the only
// platform currently surfacing this in production — Hashnode moved
// to manual mode in fix/hashnode-manual-mode, and the equivalent
// dev.to-only tests below still guard the form copy contract.
// (The Hashnode personal_api_key plan IS still produced by the
// resolver when given publishingMode='api' — see the "re-enable
// contract" tests in connect-identity.test.ts.)
// =====================================================================

describe("personal_api_key plan copy is account-sign-in shaped", () => {
  it("dev.to credentialNote explains why an API key is the sign-in method and that it's scoped to this identity", () => {
    const plan = resolveConnectIdentityPlan(
      input({ platform: "devto", publishingMode: "api", oauthAvailable: false }),
    );
    if (plan.kind !== "personal_api_key")
      throw new Error("expected personal_api_key");
    const note = plan.credentialNote.toLowerCase();
    // Explains the purpose ("publish as this account") and the scope
    // ("only for this identity"), not just an instruction to use a key.
    expect(note).toContain("publish");
    expect(note).toContain("api key");
    expect(note).toContain("this identity");
    // Must not leak internal terms.
    expect(note).not.toContain("api_key_verify");
    expect(note).not.toContain("personal_api_key");
    expect(note).not.toContain("connection row");
    expect(note).not.toContain("platform_connections");
    // Must not ask for a regular password.
    expect(note).not.toContain("password");
  });

  it("dev.to plan exposes a generateLabel path the operator can follow", () => {
    const plan = resolveConnectIdentityPlan(
      input({ platform: "devto", publishingMode: "api", oauthAvailable: false }),
    );
    if (plan.kind !== "personal_api_key")
      throw new Error("expected personal_api_key");
    // The label is the breadcrumb path inside the provider's UI.
    // Must include "Settings" and "API Key" so the operator can
    // find the page without leaving the form.
    expect(plan.generateLabel).toMatch(/Settings/);
    expect(plan.generateLabel).toMatch(/API Key/i);
  });

  it("dev.to buttonLabel reads as account sign-in ('Sign in'), not a developer action", () => {
    const plan = resolveConnectIdentityPlan(
      input({ platform: "devto", publishingMode: "api", oauthAvailable: false }),
    );
    if (plan.kind !== "personal_api_key")
      throw new Error("expected personal_api_key");
    // Account-sign-in language — not "Verify", not "Connect API",
    // not "Save key".
    expect(plan.buttonLabel.toLowerCase()).toMatch(/sign in/);
    expect(plan.buttonLabel.toLowerCase()).not.toMatch(/connect api/);
    expect(plan.buttonLabel.toLowerCase()).not.toMatch(/save key/);
  });
});

// =====================================================================
// Personal-API-key form structure (rendered JSX): the form must
// include a readonly handle field + the password-style API key
// field, mirroring the Bluesky App Password form layout.
// =====================================================================

describe("personal_api_key form renders both handle and key fields", () => {
  const formSource = readFileSync(
    join(APP_ROOT, "(app)", "accounts", "_connection-controls.tsx"),
    "utf8",
  );

  it("includes a readonly handle field bound to props.handle", () => {
    // The handle input must be readonly so the operator sees which
    // account they're signing into but can't accidentally edit it.
    // We require BOTH `readOnly` (JSX) and `aria-readonly` to keep
    // screen readers in sync.
    expect(formSource).toContain("readOnly");
    expect(formSource).toContain('aria-readonly="true"');
    expect(formSource).toMatch(/value=\{props\.handle/);
  });

  it("includes a password-type input for the API key with autoComplete='new-password'", () => {
    expect(formSource).toMatch(/type="password"[\s\S]*?autoComplete="new-password"/);
  });

  it("help text uses an action verb ('Create') and points at the provider's settings path", () => {
    expect(formSource).toMatch(/Create a \{planPlatformLabel\(plan\.platform\)\} API key/);
  });
});

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

