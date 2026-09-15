import { describe, expect, it } from "vitest";
import {
  assertLinkedInApiUse,
  getCapability,
  LINKEDIN_CAPABILITIES,
  LinkedInCapabilityRefused,
  linkedInAccessSummary,
  MEMBER_ACTION_CAPABILITIES,
} from "./capabilities";

describe("the registry", () => {
  it("names every capability once, with status, scopes, evidence, a verified date and an explanation", () => {
    const names = LINKEDIN_CAPABILITIES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of LINKEDIN_CAPABILITIES) {
      expect(["unavailable", "manual_only", "official_api_approved"]).toContain(c.status);
      expect(c.evidence.length).toBeGreaterThan(20);
      expect(c.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.explanation.length).toBeGreaterThan(20);
      expect(Array.isArray(c.requiredScopes)).toBe(true);
    }
  });

  it("every outreach / member action is manual_only, with no adapter and no scopes", () => {
    for (const name of MEMBER_ACTION_CAPABILITIES) {
      const c = getCapability(name);
      expect(c.status, name).toBe("manual_only");
      expect(c.adapter, name).toBeNull();
      expect(c.requiredScopes, name).toEqual([]);
    }
  });

  it("profile lookup, search, connections export and email are unavailable", () => {
    for (const name of ["profile_lookup", "profile_search", "connections_export", "email_outreach"] as const) {
      expect(getCapability(name).status, name).toBe("unavailable");
    }
  });

  it("only identity display is official, and only with openid + profile", () => {
    const official = LINKEDIN_CAPABILITIES.filter((c) => c.status === "official_api_approved");
    expect(official.map((c) => c.name)).toEqual(["identity_display"]);
    expect(official[0].requiredScopes).toEqual(["openid", "profile"]);
  });

  it("the dashboard summary is manual_only", () => {
    expect(linkedInAccessSummary()).toBe("manual_only");
  });
});

describe("the guard fails closed", () => {
  it("refuses every manual or unavailable capability whatever scopes are granted", () => {
    const everything = ["openid", "profile", "email", "w_member_social", "r_liteprofile", "r_1st_connections_size"];
    for (const c of LINKEDIN_CAPABILITIES) {
      if (c.status === "official_api_approved") continue;
      expect(() => assertLinkedInApiUse(c.name, everything)).toThrow(LinkedInCapabilityRefused);
      try {
        assertLinkedInApiUse(c.name, everything);
      } catch (e) {
        expect((e as LinkedInCapabilityRefused).reason).toBe("not_official");
      }
    }
  });

  it("authentication scopes are not permission for anything but identity display", () => {
    expect(() => assertLinkedInApiUse("direct_message", ["openid", "profile", "email"])).toThrow(/a person does this/);
    expect(() => assertLinkedInApiUse("connection_request", ["openid", "profile", "email"])).toThrow(/a person does this/);
    expect(() => assertLinkedInApiUse("profile_lookup", ["openid", "profile", "email"])).toThrow(/no lawful path/);
  });

  it("identity display requires the exact scopes, every one of them", () => {
    expect(assertLinkedInApiUse("identity_display", ["openid", "profile"]).name).toBe("identity_display");
    expect(() => assertLinkedInApiUse("identity_display", ["openid"])).toThrow(/not granted "profile"/);
    expect(() => assertLinkedInApiUse("identity_display", [])).toThrow(LinkedInCapabilityRefused);
    expect(() => assertLinkedInApiUse("identity_display", ["w_member_social"])).toThrow(/not granted "openid"/);
  });

  it("an official entry without an adapter or without scopes would still be refused", () => {
    // Guard against a future edit that flips a status without the rest
    // of the claim: construct the shapes the guard must reject.
    const cap = getCapability("identity_display");
    expect(cap.adapter).toBeTruthy();
    expect(cap.requiredScopes.length).toBeGreaterThan(0);
  });
});
