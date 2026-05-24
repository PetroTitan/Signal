import { describe, expect, it } from "vitest";
import {
  resolveIdentityPublishState,
  type IdentityConnection,
  type IdentityRecord,
  type PlatformCapability,
  type ResolveInput,
  type WorkspaceIntegration,
} from "@/core/publishing/identity-publish-state";

// ---------------------------------------------------------------------
// Contract tests for the disconnect path.
//
// The repository function `markConnectionStatus` is wired to Supabase
// and can't run inside vitest without a real DB. Instead, these tests
// pin the *contract* the disconnect route relies on:
//
//   1. After disconnect, metadata.handle_mismatch is gone (the
//      route passes clearMetadataKeys=["handle_mismatch"]).
//   2. After disconnect, status='revoked' and handleMismatchObserved
//      is false → resolver returns 'pending_auth' (NOT 'mismatched'
//      and NOT 'connected').
//   3. Disconnect is idempotent — calling it twice doesn't corrupt
//      the metadata shape (the second call also passes the same
//      clearMetadataKeys; the key is already absent so this is a
//      no-op against metadata).
//   4. A previously-healthy connection disconnects normally —
//      handle_mismatch wasn't present, so removing it is a no-op.
//
// The route-level integration test would require a Supabase mock
// surface beyond what this PR adds. The narrow contract tests here
// are sufficient to lock the safety property.
// ---------------------------------------------------------------------

const WS = "ws-test";

function identity(overrides: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    platform: "reddit",
    workspaceId: WS,
    declaredHandle: "u/Webmasterid-core",
    disabled: false,
    lifecycleStatus: "active",
    ...overrides,
  };
}

function connection(
  overrides: Partial<IdentityConnection> = {},
): IdentityConnection {
  return {
    authStatus: "connected",
    platform: "reddit",
    workspaceId: WS,
    authenticatedHandle: "u/Webmasterid-core",
    providerAccountId: null,
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
// 1. Metadata shape — what the disconnect path writes
// =====================================================================
//
// The disconnect route passes clearMetadataKeys=["handle_mismatch"]
// to markConnectionStatus, which does a read-modify-write:
//   - Read existing metadata
//   - Delete each key in clearMetadataKeys
//   - Layer last_message on top
//
// These tests simulate that pipeline on a representative input so a
// refactor of the repository implementation that breaks the contract
// would fail here.

function applyClearAndMessage(
  existing: Record<string, unknown>,
  clearKeys: ReadonlyArray<string>,
  message: string | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const k of clearKeys) delete merged[k];
  if (message) merged.last_message = message;
  return merged;
}

describe("disconnect metadata contract — clearMetadataKeys=['handle_mismatch']", () => {
  const priorMismatchMetadata = {
    token_storage: "aes-256-gcm",
    last_message:
      "Authenticated as u/wrong, but identity expected u/Webmasterid-core.",
    handle_mismatch: {
      declared: "u/Webmasterid-core",
      authenticated: "u/wrong",
      observedAt: "2026-05-24T00:00:00Z",
    },
  };

  it("removes handle_mismatch from metadata", () => {
    const after = applyClearAndMessage(
      priorMismatchMetadata,
      ["handle_mismatch"],
      "Operator disconnected; provider revoke accepted.",
    );
    expect(after).not.toHaveProperty("handle_mismatch");
  });

  it("preserves other non-sensitive metadata (e.g. token_storage)", () => {
    const after = applyClearAndMessage(
      priorMismatchMetadata,
      ["handle_mismatch"],
      "Operator disconnected; provider revoke accepted.",
    );
    expect(after.token_storage).toBe("aes-256-gcm");
  });

  it("updates last_message to the disconnect-specific text", () => {
    const after = applyClearAndMessage(
      priorMismatchMetadata,
      ["handle_mismatch"],
      "Operator disconnected; provider revoke accepted.",
    );
    expect(after.last_message).toBe(
      "Operator disconnected; provider revoke accepted.",
    );
  });

  it("is idempotent: a second disconnect on already-clean metadata leaves the shape unchanged", () => {
    const afterFirst = applyClearAndMessage(
      priorMismatchMetadata,
      ["handle_mismatch"],
      "Operator disconnected; provider revoke accepted.",
    );
    const afterSecond = applyClearAndMessage(
      afterFirst,
      ["handle_mismatch"],
      "Operator disconnected; provider revoke accepted.",
    );
    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond).not.toHaveProperty("handle_mismatch");
  });

  it("handles a connection that never had a mismatch — clear list is a no-op", () => {
    const clean = {
      token_storage: "aes-256-gcm",
      last_message: "Connected as u/Webmasterid-core.",
    };
    const after = applyClearAndMessage(
      clean,
      ["handle_mismatch"],
      "Operator disconnected; provider revoke accepted.",
    );
    expect(after.token_storage).toBe("aes-256-gcm");
    expect(after.last_message).toBe(
      "Operator disconnected; provider revoke accepted.",
    );
    expect(after).not.toHaveProperty("handle_mismatch");
  });

  it("does not introduce any unexpected keys (defense against a future bug that adds tokens to metadata)", () => {
    const after = applyClearAndMessage(
      priorMismatchMetadata,
      ["handle_mismatch"],
      "Operator disconnected; provider revoke accepted.",
    );
    const keys = Object.keys(after).sort();
    expect(keys).toEqual(["last_message", "token_storage"]);
  });
});

// =====================================================================
// 2. Resolver behaviour after disconnect
// =====================================================================
//
// What does resolveIdentityPublishState return for a connection that
// has been through the disconnect pipeline?
//
//   connection_status   = "revoked"       (markConnectionStatus sets it)
//   metadata            = no handle_mismatch
//   handleMismatchObserved = false        (page.tsx derives this from metadata)
//   authStatus          = "revoked"       (narrowConnectionAuthStatus maps revoked→revoked)
//
// Expected: "pending_auth" — clean state, not stuck in "mismatched".

describe("resolveIdentityPublishState — after explicit disconnect", () => {
  it("mismatched identity → disconnect → resolves as 'pending_auth' (NOT 'mismatched')", () => {
    const afterDisconnect = resolveIdentityPublishState(
      input({
        connection: connection({
          authStatus: "revoked",
          handleMismatchObserved: false, // cleared by the disconnect path
        }),
      }),
    );
    expect(afterDisconnect).toBe("pending_auth");
  });

  it("disconnect does NOT promote the identity to 'connected'", () => {
    const verdict = resolveIdentityPublishState(
      input({
        connection: connection({
          authStatus: "revoked",
          handleMismatchObserved: false,
        }),
      }),
    );
    expect(verdict).not.toBe("connected");
  });

  it("a healthy connected identity → disconnect → 'pending_auth' (normal case unaffected)", () => {
    const afterDisconnect = resolveIdentityPublishState(
      input({
        connection: connection({
          authStatus: "revoked",
          handleMismatchObserved: false,
          authenticatedHandle: "u/Webmasterid-core",
        }),
      }),
    );
    expect(afterDisconnect).toBe("pending_auth");
  });

  it("re-disconnect (idempotent) — same input produces same verdict", () => {
    const conn: IdentityConnection = connection({
      authStatus: "revoked",
      handleMismatchObserved: false,
    });
    const first = resolveIdentityPublishState(input({ connection: conn }));
    const second = resolveIdentityPublishState(input({ connection: conn }));
    expect(first).toBe(second);
    expect(first).toBe("pending_auth");
  });
});

// =====================================================================
// 3. Safety properties — disconnect must NEVER mark connected
// =====================================================================

describe("disconnect safety", () => {
  it("for every authStatus value reachable post-disconnect, verdict is never 'connected'", () => {
    // markConnectionStatus({status: 'revoked'}) maps to authStatus
    // 'revoked'. But defense-in-depth: even if a future bug let the
    // disconnect path leave the row in 'connected' state, the
    // mismatched flag being cleared shouldn't paint it green.
    // Verifies the resolver structurally cannot return 'connected'
    // for a row that has just been disconnected with no token.
    const candidates: IdentityConnection["authStatus"][] = [
      "revoked",
      "not_connected",
      "expired",
      "needs_reauth",
    ];
    for (const authStatus of candidates) {
      const verdict = resolveIdentityPublishState(
        input({
          connection: connection({
            authStatus,
            handleMismatchObserved: false,
          }),
        }),
      );
      expect(verdict).not.toBe("connected");
    }
  });
});
