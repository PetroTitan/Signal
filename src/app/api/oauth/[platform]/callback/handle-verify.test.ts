import { describe, expect, it } from "vitest";
import {
  buildHandleMismatchMetadata,
  verifyIdentityHandle,
} from "./handle-verify";

describe("verifyIdentityHandle", () => {
  it("returns 'match' when both handles agree exactly", () => {
    const r = verifyIdentityHandle({
      declaredHandle: "Webmasterid-core",
      authenticatedHandle: "Webmasterid-core",
    });
    expect(r.outcome).toBe("match");
  });

  it("returns 'match' across case differences", () => {
    const r = verifyIdentityHandle({
      declaredHandle: "Webmasterid-Core",
      authenticatedHandle: "webmasterid-core",
    });
    expect(r.outcome).toBe("match");
  });

  it("returns 'match' across u/ prefix on the declared side", () => {
    const r = verifyIdentityHandle({
      declaredHandle: "u/Webmasterid-core",
      authenticatedHandle: "Webmasterid-core",
    });
    expect(r.outcome).toBe("match");
  });

  it("returns 'mismatch' when handles disagree", () => {
    const r = verifyIdentityHandle({
      declaredHandle: "Webmasterid-core",
      authenticatedHandle: "someoneelse",
    });
    expect(r.outcome).toBe("mismatch");
    expect(r.declaredHandle).toBe("Webmasterid-core");
    expect(r.authenticatedHandle).toBe("someoneelse");
  });

  it("returns 'indeterminate' when the declared handle is missing", () => {
    const r = verifyIdentityHandle({
      declaredHandle: null,
      authenticatedHandle: "Webmasterid-core",
    });
    expect(r.outcome).toBe("indeterminate");
  });

  it("returns 'indeterminate' when the authenticated handle is missing", () => {
    const r = verifyIdentityHandle({
      declaredHandle: "Webmasterid-core",
      authenticatedHandle: null,
    });
    expect(r.outcome).toBe("indeterminate");
  });

  it("returns 'indeterminate' when both sides are empty strings", () => {
    const r = verifyIdentityHandle({
      declaredHandle: "",
      authenticatedHandle: "",
    });
    expect(r.outcome).toBe("indeterminate");
  });

  it("preserves the original (un-normalized) handles for UI rendering", () => {
    const r = verifyIdentityHandle({
      declaredHandle: "  u/Webmasterid-Core  ",
      authenticatedHandle: "someoneelse",
    });
    expect(r.declaredHandle).toBe("u/Webmasterid-Core");
    expect(r.authenticatedHandle).toBe("someoneelse");
  });
});

describe("buildHandleMismatchMetadata", () => {
  it("serializes the mismatch payload with an ISO timestamp", () => {
    const payload = buildHandleMismatchMetadata({
      outcome: "mismatch",
      declaredHandle: "u/Webmasterid-core",
      authenticatedHandle: "someoneelse",
    });
    expect(payload.declared).toBe("u/Webmasterid-core");
    expect(payload.authenticated).toBe("someoneelse");
    expect(new Date(payload.observedAt).toString()).not.toBe("Invalid Date");
  });
});
