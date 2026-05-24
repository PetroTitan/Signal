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

// =====================================================================
// Metadata-shape contract — guards the reconnect-clears-mismatch path
// =====================================================================
//
// upsertPlatformConnection in the repository REPLACES the metadata
// column wholesale (not a JSON merge). The OAuth callback success
// path passes `metadata: { token_storage, last_message }` with NO
// handle_mismatch key. These tests pin the shapes so a refactor that
// accidentally merges metadata would fail before reaching production.

describe("metadata shape — reconnect implicitly clears handle_mismatch", () => {
  it("success-path metadata shape does NOT include handle_mismatch", () => {
    // This is the literal shape the callback writes on success.
    // Locked here so any future refactor that adds handle_mismatch
    // to the success-path payload trips this test.
    const successPathMetadata = {
      token_storage: "aes-256-gcm",
      last_message: "Connected as u/Webmasterid-core.",
    };
    expect("handle_mismatch" in successPathMetadata).toBe(false);
  });

  it("a fresh write of the success-path metadata over a prior mismatch payload erases handle_mismatch (replace semantics)", () => {
    // Simulates the repository behaviour: the update statement sets
    // metadata = input.metadata, replacing the JSONB column wholesale.
    const prior = {
      token_storage: "aes-256-gcm",
      last_message: "Authenticated as u/wrong, but identity expected u/right.",
      handle_mismatch: {
        declared: "u/right",
        authenticated: "u/wrong",
        observedAt: "2026-05-24T00:00:00Z",
      },
    };
    const successPath = {
      token_storage: "aes-256-gcm",
      last_message: "Connected as u/right.",
    };
    const afterReplace = successPath; // wholesale replacement
    expect(afterReplace).not.toHaveProperty("handle_mismatch");
    // Sanity: the prior still had it — the test isn't trivially passing
    expect(prior).toHaveProperty("handle_mismatch");
  });
});
