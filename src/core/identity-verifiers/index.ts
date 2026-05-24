/**
 * Identity verifiers — public surface.
 *
 * Per-platform handle / credential adapters used by the
 * Connect-Identity routes. Each module is pure functions that take
 * declared identity context and return typed verdicts.
 *
 * Verifier modules do NOT persist anything. The routes are
 * responsible for upserting platform_connections rows based on the
 * verifier's result.
 *
 * Bluesky has two distinct flows:
 *   - bluesky-resolve.ts  — PUBLIC handle → DID lookup. Proves the
 *                            handle exists; does NOT prove ownership.
 *                            Used as a diagnostic; routes that call
 *                            it MUST NOT mark identity connected.
 *   - bluesky-session.ts  — App-password authenticated session via
 *                            AT Protocol com.atproto.server.create
 *                            Session. Proves ownership. Routes that
 *                            call it persist encrypted tokens and
 *                            mark identity connected only after the
 *                            authenticated DID/handle matches the
 *                            identity.
 */

// Public handle resolution (informational only)
export {
  resolveBlueskyHandle,
  normalizeBlueskyHandle,
  isValidBlueskyHandle,
} from "./bluesky-resolve";
export type {
  BlueskyResolveInput,
  BlueskyResolveResult,
  BlueskyHandleResolved,
  BlueskyHandleMismatched,
  BlueskyResolveError,
  BlueskyResolveErrorCode,
} from "./bluesky-resolve";

// App-password session connect (ownership-proving)
export { connectBlueskyWithAppPassword } from "./bluesky-session";
export type {
  BlueskySessionInput,
  BlueskySessionResult,
  BlueskySessionConnected,
  BlueskySessionMismatched,
  BlueskySessionError,
  BlueskySessionErrorCode,
} from "./bluesky-session";
export { buildBlueskySessionPlan } from "./bluesky-session-persistence";
export type {
  BlueskySessionPlan,
  BlueskySessionPlanInput,
} from "./bluesky-session-persistence";

// dev.to personal-API-key verifier
export {
  verifyDevtoIdentity,
  normalizeDevtoUsername,
  isValidDevtoUsername,
} from "./devto";
export type {
  DevtoVerifierInput,
  DevtoVerifierResult,
  DevtoVerifierConnected,
  DevtoVerifierMismatched,
  DevtoVerifierError,
  DevtoVerifierErrorCode,
} from "./devto";
export { buildDevtoVerifyPlan } from "./devto-persistence";
export type {
  DevtoVerifyPlan,
  DevtoVerifyPlanInput,
} from "./devto-persistence";
