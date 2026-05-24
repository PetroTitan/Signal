import { describe, expect, it } from "vitest";
import {
  isApiKeyVerifyPlatform,
  isAppPasswordPlatform,
  isOAuthCapablePlatform,
  isPersonalApiKeyPlatform,
  resolveConnectIdentityPlan,
  shouldShowManageButton,
  type ConnectIdentityInput,
} from "./connect-identity";

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

describe("resolveConnectIdentityPlan — OAuth platforms", () => {
  it("returns an oauth plan for Reddit with the correct Signal-side authorize URL", () => {
    const plan = resolveConnectIdentityPlan(input());
    expect(plan.kind).toBe("oauth");
    if (plan.kind !== "oauth") return;
    expect(plan.authorizeUrl).toBe(
      "/api/oauth/reddit/start?account_id=id-1",
    );
    expect(plan.buttonLabel).toBe("Sign in to this account");
  });

  it("includes redirect_after in the authorize URL when provided", () => {
    const plan = resolveConnectIdentityPlan(
      input({ redirectAfter: "/accounts" }),
    );
    if (plan.kind !== "oauth") throw new Error("expected oauth plan");
    expect(plan.authorizeUrl).toContain("account_id=id-1");
    expect(plan.authorizeUrl).toContain(
      "redirect_after=%2Faccounts",
    );
  });

  it("falls back to manual when oauthAvailable is false for an OAuth-capable platform", () => {
    // Operationally: Reddit's API approval is pending → manual mode
    // even though Reddit is OAuth-capable as a platform.
    const plan = resolveConnectIdentityPlan(
      input({ oauthAvailable: false }),
    );
    expect(plan.kind).toBe("manual");
  });
});

describe("resolveConnectIdentityPlan — app-password platforms", () => {
  it("returns an app_password plan for Bluesky (NOT api_key_verify)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "bluesky",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    expect(plan.kind).toBe("app_password");
    if (plan.kind !== "app_password") return;
    expect(plan.resolveUrl).toBe("/api/identity/id-1/verify");
    expect(plan.connectUrl).toBe("/api/identity/id-1/bluesky/connect");
    expect(plan.signOutUrl).toBe("/api/identity/id-1/bluesky/sign-out");
    expect(plan.buttonLabel).toBe("Sign in with Bluesky App Password");
    // The note must explicitly steer the operator away from their
    // main password — the whole point of the corrected model.
    expect(plan.credentialNote.toLowerCase()).toContain("app password");
    expect(plan.credentialNote.toLowerCase()).toContain(
      "not your main password",
    );
    // Mentions the per-account scope so the operator understands the
    // App Password must be specific to this identity's account.
    expect(plan.credentialNote.toLowerCase()).toContain("this exact account");
  });

  it("signOutUrl is identity-scoped — two identities on the same platform have distinct sign-out URLs", () => {
    const planA = resolveConnectIdentityPlan(
      input({
        identityId: "identity-a",
        platform: "bluesky",
        publishingMode: "api",
      }),
    );
    const planB = resolveConnectIdentityPlan(
      input({
        identityId: "identity-b",
        platform: "bluesky",
        publishingMode: "api",
      }),
    );
    if (planA.kind !== "app_password" || planB.kind !== "app_password")
      throw new Error("expected app_password");
    expect(planA.signOutUrl).toBe("/api/identity/identity-a/bluesky/sign-out");
    expect(planB.signOutUrl).toBe("/api/identity/identity-b/bluesky/sign-out");
    expect(planA.signOutUrl).not.toBe(planB.signOutUrl);
    // Same for connect: two identities never collide.
    expect(planA.connectUrl).not.toBe(planB.connectUrl);
  });
});

describe("resolveConnectIdentityPlan — personal-API-key platforms", () => {
  it("returns a personal_api_key plan for dev.to (NOT api_key_verify)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "devto",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    expect(plan.kind).toBe("personal_api_key");
    if (plan.kind !== "personal_api_key") return;
    expect(plan.connectUrl).toBe("/api/identity/id-1/devto/connect");
    expect(plan.signOutUrl).toBe("/api/identity/id-1/devto/sign-out");
    expect(plan.buttonLabel).toBe("Sign in with dev.to API key");
    expect(plan.credentialNote.toLowerCase()).toContain(
      "this exact account",
    );
    expect(plan.secretFieldLabel.toLowerCase()).toContain("api key");
  });

  it("dev.to signOutUrl is identity-scoped — two dev.to identities have distinct URLs", () => {
    const planA = resolveConnectIdentityPlan(
      input({
        identityId: "id-A",
        platform: "devto",
        publishingMode: "api",
      }),
    );
    const planB = resolveConnectIdentityPlan(
      input({
        identityId: "id-B",
        platform: "devto",
        publishingMode: "api",
      }),
    );
    if (planA.kind !== "personal_api_key" || planB.kind !== "personal_api_key")
      throw new Error("expected personal_api_key");
    expect(planA.signOutUrl).not.toBe(planB.signOutUrl);
    expect(planA.connectUrl).not.toBe(planB.connectUrl);
  });

  it("returns a personal_api_key plan for Hashnode (NOT api_key_verify)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "hashnode",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    expect(plan.kind).toBe("personal_api_key");
    if (plan.kind !== "personal_api_key") return;
    expect(plan.connectUrl).toBe("/api/identity/id-1/hashnode/connect");
    expect(plan.signOutUrl).toBe("/api/identity/id-1/hashnode/sign-out");
    expect(plan.buttonLabel).toBe("Sign in with Hashnode API key");
    expect(plan.credentialNote.toLowerCase()).toContain(
      "this exact account",
    );
    expect(plan.secretFieldLabel.toLowerCase()).toContain("hashnode");
    expect(plan.generateUrl).toContain("hashnode.com");
  });

  it("Hashnode signOutUrl is identity-scoped — two Hashnode identities have distinct URLs", () => {
    const planA = resolveConnectIdentityPlan(
      input({
        identityId: "id-A",
        platform: "hashnode",
        publishingMode: "api",
      }),
    );
    const planB = resolveConnectIdentityPlan(
      input({
        identityId: "id-B",
        platform: "hashnode",
        publishingMode: "api",
      }),
    );
    if (planA.kind !== "personal_api_key" || planB.kind !== "personal_api_key")
      throw new Error("expected personal_api_key");
    expect(planA.signOutUrl).not.toBe(planB.signOutUrl);
    expect(planA.connectUrl).not.toBe(planB.connectUrl);
  });

  it("dev.to and Hashnode plans don't collide — distinct connect/sign-out URLs per platform", () => {
    const devto = resolveConnectIdentityPlan(
      input({ platform: "devto", publishingMode: "api" }),
    );
    const hashnode = resolveConnectIdentityPlan(
      input({ platform: "hashnode", publishingMode: "api" }),
    );
    if (devto.kind !== "personal_api_key" || hashnode.kind !== "personal_api_key")
      throw new Error("expected personal_api_key");
    expect(devto.connectUrl).not.toBe(hashnode.connectUrl);
    expect(devto.signOutUrl).not.toBe(hashnode.signOutUrl);
  });
});

describe("resolveConnectIdentityPlan — API-key verify platforms (workspace-shared key + per-identity verify)", () => {
  it("returns a telegram-specific api_key_verify plan with dedicated verify + sign-out URLs", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "telegram",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    expect(plan.kind).toBe("api_key_verify");
    if (plan.kind !== "api_key_verify") return;
    expect(plan.verifyUrl).toBe("/api/identity/id-1/telegram/verify");
    expect(plan.signOutUrl).toBe("/api/identity/id-1/telegram/sign-out");
    expect(plan.buttonLabel.toLowerCase()).toContain("telegram");
  });

  it("Telegram plan carries operator setup instructions (bot must be added as admin)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "telegram",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    if (plan.kind !== "api_key_verify") throw new Error("expected api_key_verify");
    expect(plan.setupInstructions).toBeDefined();
    const instructions = (plan.setupInstructions ?? []).join(" ").toLowerCase();
    expect(instructions).toContain("admin");
    expect(instructions).toContain("channel");
  });

  it("Telegram signOutUrl is identity-scoped — two Telegram identities have distinct URLs", () => {
    const planA = resolveConnectIdentityPlan(
      input({
        identityId: "id-A",
        platform: "telegram",
        publishingMode: "api",
      }),
    );
    const planB = resolveConnectIdentityPlan(
      input({
        identityId: "id-B",
        platform: "telegram",
        publishingMode: "api",
      }),
    );
    if (planA.kind !== "api_key_verify" || planB.kind !== "api_key_verify")
      throw new Error("expected api_key_verify");
    expect(planA.signOutUrl).not.toBe(planB.signOutUrl);
    expect(planA.verifyUrl).not.toBe(planB.verifyUrl);
  });

  it("requires publishingMode='api' — manual mode with the same platform falls back to manual", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "bluesky",
        publishingMode: "manual",
        oauthAvailable: false,
      }),
    );
    expect(plan.kind).toBe("manual");
  });
});

describe("resolveConnectIdentityPlan — manual / distribution platforms", () => {
  it.each(["x", "linkedin", "youtube", "threads", "instagram"] as const)(
    "returns a manual plan for distribution platform %s",
    (platform) => {
      const plan = resolveConnectIdentityPlan(
        input({
          platform,
          publishingMode: "manual",
          distributionOnly: true,
          oauthAvailable: false,
        }),
      );
      expect(plan.kind).toBe("manual");
      if (plan.kind !== "manual") return;
      expect(plan.hint.toLowerCase()).toContain("manual distribution");
    },
  );

  it("returns a manual plan for indie_hackers (manual-only, not distribution)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "indie_hackers",
        publishingMode: "manual",
        distributionOnly: false,
        oauthAvailable: false,
      }),
    );
    expect(plan.kind).toBe("manual");
    if (plan.kind !== "manual") return;
    expect(plan.hint.toLowerCase()).toContain("manual publish");
  });
});

describe("resolveConnectIdentityPlan — unsupported platforms", () => {
  it("returns unsupported when publishingMode is 'not_implemented'", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "reddit",
        publishingMode: "not_implemented",
      }),
    );
    expect(plan.kind).toBe("unsupported");
  });
});

describe("isOAuthCapablePlatform / isAppPasswordPlatform / isApiKeyVerifyPlatform", () => {
  it("Reddit is OAuth-capable; nothing else (yet)", () => {
    expect(isOAuthCapablePlatform("reddit")).toBe(true);
    expect(isOAuthCapablePlatform("bluesky")).toBe(false);
    expect(isOAuthCapablePlatform("x")).toBe(false);
    expect(isOAuthCapablePlatform("linkedin")).toBe(false);
  });

  it("Bluesky is an app-password platform (NOT api_key_verify anymore)", () => {
    expect(isAppPasswordPlatform("bluesky")).toBe(true);
    expect(isApiKeyVerifyPlatform("bluesky")).toBe(false);
  });

  it("dev.to + Hashnode are personal-API-key platforms (NOT api_key_verify anymore)", () => {
    expect(isPersonalApiKeyPlatform("devto")).toBe(true);
    expect(isPersonalApiKeyPlatform("hashnode")).toBe(true);
    expect(isApiKeyVerifyPlatform("devto")).toBe(false);
    expect(isApiKeyVerifyPlatform("hashnode")).toBe(false);
  });

  it("Telegram is an API-key verify platform (workspace bot token + per-identity channel verify)", () => {
    expect(isApiKeyVerifyPlatform("telegram")).toBe(true);
    expect(isPersonalApiKeyPlatform("telegram")).toBe(false);
  });

  it("Distribution and manual-only platforms belong to none of the four groups", () => {
    for (const p of [
      "x",
      "linkedin",
      "youtube",
      "threads",
      "instagram",
      "indie_hackers",
    ] as const) {
      expect(isOAuthCapablePlatform(p)).toBe(false);
      expect(isAppPasswordPlatform(p)).toBe(false);
      expect(isPersonalApiKeyPlatform(p)).toBe(false);
      expect(isApiKeyVerifyPlatform(p)).toBe(false);
    }
  });
});

// =====================================================================
// shouldShowManageButton — drives the identity-card Manage affordance
// =====================================================================

describe("shouldShowManageButton", () => {
  it("shows Manage for OAuth plans", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "reddit",
        publishingMode: "manual",
        oauthAvailable: true,
      }),
    );
    expect(shouldShowManageButton(plan)).toBe(true);
  });

  it("shows Manage for app_password plans (Bluesky)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "bluesky",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    expect(shouldShowManageButton(plan)).toBe(true);
  });

  it("shows Manage for personal_api_key plans (dev.to)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "devto",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    expect(shouldShowManageButton(plan)).toBe(true);
  });

  it("shows Manage for personal_api_key plans (Hashnode)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "hashnode",
        publishingMode: "api",
        oauthAvailable: false,
      }),
    );
    expect(shouldShowManageButton(plan)).toBe(true);
  });

  it("shows Manage for api_key_verify plans (Telegram only — Hashnode moved out)", () => {
    for (const platform of ["telegram"] as const) {
      const plan = resolveConnectIdentityPlan(
        input({
          platform,
          publishingMode: "api",
          oauthAvailable: false,
        }),
      );
      expect(shouldShowManageButton(plan)).toBe(true);
    }
  });

  it("shows Manage for manual plans (so manual platforms get the same affordance + steady-state explanation)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "x",
        publishingMode: "manual",
        distributionOnly: true,
        oauthAvailable: false,
      }),
    );
    expect(shouldShowManageButton(plan)).toBe(true);
  });

  it("hides Manage for unsupported plans (no action surface)", () => {
    const plan = resolveConnectIdentityPlan(
      input({
        platform: "reddit",
        publishingMode: "not_implemented",
      }),
    );
    expect(shouldShowManageButton(plan)).toBe(false);
  });

  it("hides Manage when no plan is provided", () => {
    expect(shouldShowManageButton(undefined)).toBe(false);
  });
});
