import { describe, expect, it } from "vitest";
import {
  isApiKeyVerifyPlatform,
  isOAuthCapablePlatform,
  resolveConnectIdentityPlan,
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
    expect(plan.buttonLabel).toBe("Connect identity");
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

describe("resolveConnectIdentityPlan — API-key verify platforms", () => {
  it.each(["bluesky", "devto", "hashnode", "telegram"] as const)(
    "returns an api_key_verify plan for %s",
    (platform) => {
      const plan = resolveConnectIdentityPlan(
        input({
          platform,
          publishingMode: "api",
          oauthAvailable: false,
        }),
      );
      expect(plan.kind).toBe("api_key_verify");
      if (plan.kind !== "api_key_verify") return;
      expect(plan.verifyUrl).toBe(`/api/identity/id-1/verify`);
      expect(plan.buttonLabel).toBe("Verify identity");
    },
  );

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

describe("isOAuthCapablePlatform / isApiKeyVerifyPlatform", () => {
  it("Reddit is OAuth-capable; nothing else (yet)", () => {
    expect(isOAuthCapablePlatform("reddit")).toBe(true);
    expect(isOAuthCapablePlatform("bluesky")).toBe(false);
    expect(isOAuthCapablePlatform("x")).toBe(false);
    expect(isOAuthCapablePlatform("linkedin")).toBe(false);
  });

  it("Bluesky/dev.to/Hashnode/Telegram are API-key verify platforms", () => {
    expect(isApiKeyVerifyPlatform("bluesky")).toBe(true);
    expect(isApiKeyVerifyPlatform("devto")).toBe(true);
    expect(isApiKeyVerifyPlatform("hashnode")).toBe(true);
    expect(isApiKeyVerifyPlatform("telegram")).toBe(true);
  });

  it("Distribution and manual-only platforms are neither", () => {
    for (const p of [
      "x",
      "linkedin",
      "youtube",
      "threads",
      "instagram",
      "indie_hackers",
    ] as const) {
      expect(isOAuthCapablePlatform(p)).toBe(false);
      expect(isApiKeyVerifyPlatform(p)).toBe(false);
    }
  });
});
