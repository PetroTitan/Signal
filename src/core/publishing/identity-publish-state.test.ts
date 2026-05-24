import { describe, expect, it } from "vitest";
import {
  canAutoPublish,
  compareHandles,
  IDENTITY_PUBLISH_STATES,
  IDENTITY_PUBLISH_STATE_LABELS,
  IDENTITY_PUBLISH_STATE_TONES,
  narrowConnectionAuthStatus,
  normalizeHandle,
  resolveIdentityPublishState,
  type IdentityConnection,
  type IdentityRecord,
  type PlatformCapability,
  type ResolveInput,
  type WorkspaceIntegration,
} from "./identity-publish-state";

const WS = "ws-test";

// ---------------------------------------------------------------------
// Builders for test inputs. Keep tests focused on the resolver's
// behaviour, not on object construction noise.
// ---------------------------------------------------------------------

function identity(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    platform: "bluesky",
    workspaceId: WS,
    declaredHandle: "@webmasterid.bsky.social",
    disabled: false,
    lifecycleStatus: "active",
    ...overrides,
  };
}

function platform(
  overrides: Partial<PlatformCapability> = {},
): PlatformCapability {
  return { publishingMode: "api", ...overrides };
}

function workspace(
  overrides: Partial<WorkspaceIntegration> = {},
): WorkspaceIntegration {
  return { configured: true, ...overrides };
}

function connection(
  overrides: Partial<IdentityConnection> = {},
): IdentityConnection {
  return {
    authStatus: "connected",
    platform: "bluesky",
    workspaceId: WS,
    authenticatedHandle: "@webmasterid.bsky.social",
    providerAccountId: null,
    ...overrides,
  };
}

function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    identity: identity(),
    platform: platform(),
    workspace: workspace(),
    connection: connection(),
    ...overrides,
  };
}

// =====================================================================
// Test cases the brief required
// =====================================================================

describe("resolveIdentityPublishState — happy path", () => {
  it("returns 'connected' when API platform + workspace configured + identity authed", () => {
    expect(resolveIdentityPublishState(input())).toBe("connected");
  });
});

describe("resolveIdentityPublishState — expired token", () => {
  it("returns 'expired' when the identity's auth has expired", () => {
    expect(
      resolveIdentityPublishState(
        input({ connection: connection({ authStatus: "expired" }) }),
      ),
    ).toBe("expired");
  });

  it("returns 'expired' when reauthorization is required", () => {
    expect(
      resolveIdentityPublishState(
        input({ connection: connection({ authStatus: "needs_reauth" }) }),
      ),
    ).toBe("expired");
  });
});

describe("resolveIdentityPublishState — missing token / OAuth revocation", () => {
  it("returns 'pending_auth' when no connection row exists", () => {
    expect(resolveIdentityPublishState(input({ connection: null }))).toBe(
      "pending_auth",
    );
  });

  it("returns 'pending_auth' when the connection is revoked", () => {
    expect(
      resolveIdentityPublishState(
        input({ connection: connection({ authStatus: "revoked" }) }),
      ),
    ).toBe("pending_auth");
  });

  it("returns 'pending_auth' when the connection is not_connected", () => {
    expect(
      resolveIdentityPublishState(
        input({ connection: connection({ authStatus: "not_connected" }) }),
      ),
    ).toBe("pending_auth");
  });
});

describe("resolveIdentityPublishState — automated platforms without workspace auth", () => {
  it("returns 'pending_auth' when workspace credentials are missing — even if the identity row claims 'connected'", () => {
    // This is the core anti-conflation case. A stale identity row
    // claiming 'connected' must not survive the workspace-integration
    // gate being false. The UI should never label this as Connected.
    expect(
      resolveIdentityPublishState(
        input({
          workspace: workspace({ configured: false }),
          connection: connection({ authStatus: "connected" }),
        }),
      ),
    ).toBe("pending_auth");
  });
});

describe("resolveIdentityPublishState — manual-first / distribution platforms", () => {
  it("returns 'manual' for a manual-mode platform regardless of any OAuth state", () => {
    expect(
      resolveIdentityPublishState(
        input({
          platform: platform({ publishingMode: "manual" }),
          connection: connection({ authStatus: "connected" }),
        }),
      ),
    ).toBe("manual");
  });

  it("returns 'manual' for a distribution-mode platform regardless of any OAuth state", () => {
    expect(
      resolveIdentityPublishState(
        input({
          platform: platform({ publishingMode: "distribution" }),
          connection: connection({ authStatus: "connected" }),
        }),
      ),
    ).toBe("manual");
  });

  it("never returns 'connected' for distribution platforms even with workspace integration", () => {
    expect(
      resolveIdentityPublishState(
        input({
          platform: platform({ publishingMode: "distribution" }),
          workspace: workspace({ configured: true }),
          connection: connection({ authStatus: "connected" }),
        }),
      ),
    ).toBe("manual");
  });
});

describe("resolveIdentityPublishState — unsupported", () => {
  it("returns 'unsupported' when the platform has no publishing path", () => {
    expect(
      resolveIdentityPublishState(
        input({ platform: platform({ publishingMode: "not_implemented" }) }),
      ),
    ).toBe("unsupported");
  });

  it("'unsupported' beats workspace + identity auth state", () => {
    expect(
      resolveIdentityPublishState(
        input({
          platform: platform({ publishingMode: "not_implemented" }),
          connection: connection({ authStatus: "connected" }),
        }),
      ),
    ).toBe("unsupported");
  });
});

describe("resolveIdentityPublishState — disabled", () => {
  it("returns 'disabled' when the identity is explicitly disabled", () => {
    expect(
      resolveIdentityPublishState(
        input({ identity: identity({ disabled: true }) }),
      ),
    ).toBe("disabled");
  });

  it("returns 'disabled' when the identity is archived", () => {
    expect(
      resolveIdentityPublishState(
        input({ identity: identity({ lifecycleStatus: "archived" }) }),
      ),
    ).toBe("disabled");
  });

  it("'disabled' beats everything else (highest precedence)", () => {
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({ disabled: true }),
          platform: platform({ publishingMode: "not_implemented" }),
          workspace: workspace({ configured: false }),
          connection: null,
        }),
      ),
    ).toBe("disabled");
  });
});

describe("resolveIdentityPublishState — multiple identities on same platform", () => {
  // One platform_connections row per identity. The workspace
  // integration (env-vars) is shared across all identities on the
  // platform, but auth state is NOT shared. An OAuth connection on
  // one identity must not implicitly connect another identity.
  it("identity A is connected; identity B with no row remains pending_auth", () => {
    const sharedPlatform = platform({ publishingMode: "api" });
    const sharedWorkspace = workspace({ configured: true });

    const identityA = resolveIdentityPublishState({
      identity: identity({ platform: "bluesky" }),
      platform: sharedPlatform,
      workspace: sharedWorkspace,
      connection: connection({ authStatus: "connected" }),
    });
    const identityB = resolveIdentityPublishState({
      identity: identity({ platform: "bluesky" }),
      platform: sharedPlatform,
      workspace: sharedWorkspace,
      connection: null,
    });

    expect(identityA).toBe("connected");
    expect(identityB).toBe("pending_auth");
  });

  it("identity A expired; identity B fresh connection resolve independently", () => {
    const sharedPlatform = platform({ publishingMode: "api" });
    const sharedWorkspace = workspace({ configured: true });

    const aState = resolveIdentityPublishState({
      identity: identity({ platform: "devto", declaredHandle: "petro_a" }),
      platform: sharedPlatform,
      workspace: sharedWorkspace,
      connection: connection({
        authStatus: "expired",
        platform: "devto",
        authenticatedHandle: "petro_a",
      }),
    });
    const bState = resolveIdentityPublishState({
      identity: identity({ platform: "devto", declaredHandle: "petro_b" }),
      platform: sharedPlatform,
      workspace: sharedWorkspace,
      connection: connection({
        authStatus: "connected",
        platform: "devto",
        authenticatedHandle: "petro_b",
      }),
    });

    expect(aState).toBe("expired");
    expect(bState).toBe("connected");
  });
});

describe("resolveIdentityPublishState — workspace isolation", () => {
  // The resolver is a pure function of its inputs. It has no
  // workspace identity to leak. We verify isolation by demonstrating
  // that two separate calls with identical inputs are independent —
  // mutating one input doesn't change the other resolution.
  it("two parallel resolutions on different inputs do not share state", () => {
    const a = resolveIdentityPublishState(input());
    const b = resolveIdentityPublishState(
      input({ connection: connection({ authStatus: "expired" }) }),
    );
    expect(a).toBe("connected");
    expect(b).toBe("expired");
  });

  it("does not mutate its input", () => {
    const i = input();
    const before = JSON.stringify(i);
    resolveIdentityPublishState(i);
    expect(JSON.stringify(i)).toBe(before);
  });
});

describe("resolveIdentityPublishState — determinism", () => {
  it("same input → same output across repeated calls", () => {
    const cases: ResolveInput[] = [
      input(),
      input({ connection: null }),
      input({ identity: identity({ disabled: true }) }),
      input({
        platform: platform({ publishingMode: "distribution" }),
        connection: connection({ authStatus: "connected" }),
      }),
      input({
        platform: platform({ publishingMode: "api" }),
        workspace: workspace({ configured: false }),
      }),
    ];
    for (const c of cases) {
      const a = resolveIdentityPublishState(c);
      const b = resolveIdentityPublishState(c);
      expect(a).toBe(b);
    }
  });
});

// =====================================================================
// narrowConnectionAuthStatus
// =====================================================================

describe("narrowConnectionAuthStatus", () => {
  it("'connected' and 'healthy' both map to 'connected'", () => {
    expect(narrowConnectionAuthStatus("connected")).toBe("connected");
    expect(narrowConnectionAuthStatus("healthy")).toBe("connected");
  });
  it("'expired' maps to 'expired'", () => {
    expect(narrowConnectionAuthStatus("expired")).toBe("expired");
  });
  it("'reauthorization_required' maps to 'needs_reauth'", () => {
    expect(narrowConnectionAuthStatus("reauthorization_required")).toBe(
      "needs_reauth",
    );
  });
  it("'revoked' maps to 'revoked'", () => {
    expect(narrowConnectionAuthStatus("revoked")).toBe("revoked");
  });
  it("null/undefined/error/unknown values collapse to 'not_connected'", () => {
    expect(narrowConnectionAuthStatus(null)).toBe("not_connected");
    expect(narrowConnectionAuthStatus(undefined)).toBe("not_connected");
    expect(narrowConnectionAuthStatus("error")).toBe("not_connected");
    expect(narrowConnectionAuthStatus("degraded")).toBe("not_connected");
    expect(narrowConnectionAuthStatus("ready_to_connect")).toBe(
      "not_connected",
    );
    expect(narrowConnectionAuthStatus("pending_authorization")).toBe(
      "not_connected",
    );
  });
});

// =====================================================================
// Handle mismatch — token belongs to another account on the same platform
// =====================================================================

describe("resolveIdentityPublishState — handle mismatch", () => {
  it("returns 'mismatched' when the token's handle differs from the identity's declared handle", () => {
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({
            declaredHandle: "@webmasterid.bsky.social",
          }),
          connection: connection({
            authStatus: "connected",
            authenticatedHandle: "@someoneelse.bsky.social",
          }),
        }),
      ),
    ).toBe("mismatched");
  });

  it("normalizes handles before comparing (@ prefix, case, whitespace)", () => {
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({
            declaredHandle: "  @WebmasterID.bsky.social ",
          }),
          connection: connection({
            authenticatedHandle: "webmasterid.bsky.social",
          }),
        }),
      ),
    ).toBe("connected");
  });

  it("normalizes Reddit 'u/' prefix when comparing", () => {
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({
            platform: "reddit",
            declaredHandle: "u/Webmasterid-core",
          }),
          connection: connection({
            platform: "reddit",
            authenticatedHandle: "webmasterid-core",
          }),
        }),
      ),
    ).toBe("connected");
  });

  it("returns 'connected' when the declared handle is unknown (indeterminate)", () => {
    // No declared handle means we trust the token; this matches
    // identities like Instagram where the handle isn't recorded.
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({ declaredHandle: null }),
          connection: connection({
            authenticatedHandle: "@anything",
          }),
        }),
      ),
    ).toBe("connected");
  });

  it("returns 'connected' when the authenticated handle is unknown (indeterminate)", () => {
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({ declaredHandle: "@something" }),
          connection: connection({
            authenticatedHandle: null,
          }),
        }),
      ),
    ).toBe("connected");
  });
});

// =====================================================================
// Platform mismatch — connection row wired to the wrong platform
// =====================================================================

describe("resolveIdentityPublishState — platform mismatch", () => {
  it("returns 'pending_auth' when the connection row's platform differs from the identity's platform", () => {
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({ platform: "bluesky" }),
          connection: connection({ platform: "reddit" }),
        }),
      ),
    ).toBe("pending_auth");
  });
});

// =====================================================================
// Workspace mismatch — defense in depth against cross-workspace leaks
// =====================================================================

describe("resolveIdentityPublishState — workspace mismatch", () => {
  it("returns 'pending_auth' when the connection row belongs to a different workspace", () => {
    expect(
      resolveIdentityPublishState(
        input({
          identity: identity({ workspaceId: "ws-A" }),
          connection: connection({ workspaceId: "ws-B" }),
        }),
      ),
    ).toBe("pending_auth");
  });
});

// =====================================================================
// Helper functions
// =====================================================================

describe("normalizeHandle", () => {
  it("strips @ prefix, lowercases, trims", () => {
    expect(normalizeHandle("  @Webmasterid  ")).toBe("webmasterid");
  });
  it("strips u/ prefix", () => {
    expect(normalizeHandle("u/Webmasterid-core")).toBe("webmasterid-core");
  });
  it("returns null for empty / null / whitespace", () => {
    expect(normalizeHandle(null)).toBeNull();
    expect(normalizeHandle("")).toBeNull();
    expect(normalizeHandle("   ")).toBeNull();
  });
});

describe("compareHandles", () => {
  it("matches case-and-prefix-insensitive", () => {
    expect(compareHandles("@WebmasterID", "webmasterid")).toBe("match");
  });
  it("returns 'mismatch' for two different handles", () => {
    expect(compareHandles("@a", "@b")).toBe("mismatch");
  });
  it("returns 'indeterminate' when either side is missing", () => {
    expect(compareHandles(null, "@x")).toBe("indeterminate");
    expect(compareHandles("@x", null)).toBe("indeterminate");
  });
});

// =====================================================================
// UI-helper integrity
// =====================================================================

describe("UI-helper tables are complete", () => {
  it("every state has a label", () => {
    for (const s of IDENTITY_PUBLISH_STATES) {
      expect(IDENTITY_PUBLISH_STATE_LABELS[s]).toBeTruthy();
    }
  });
  it("every state has a tone", () => {
    for (const s of IDENTITY_PUBLISH_STATES) {
      expect(IDENTITY_PUBLISH_STATE_TONES[s]).toBeTruthy();
    }
  });
  it("only 'connected' qualifies as canAutoPublish", () => {
    for (const s of IDENTITY_PUBLISH_STATES) {
      expect(canAutoPublish(s)).toBe(s === "connected");
    }
  });
  it("only 'connected' has tone 'success'", () => {
    for (const s of IDENTITY_PUBLISH_STATES) {
      if (s === "connected") {
        expect(IDENTITY_PUBLISH_STATE_TONES[s]).toBe("success");
      } else {
        expect(IDENTITY_PUBLISH_STATE_TONES[s]).not.toBe("success");
      }
    }
  });
});
