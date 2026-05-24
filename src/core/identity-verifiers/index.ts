/**
 * Identity verifiers — public surface.
 *
 * Per-platform handle resolution adapters used by the
 * /api/identity/[identityId]/verify route. Each verifier is a pure
 * function that takes a declared handle + identity context and
 * returns a typed verdict (verified | mismatched | error).
 *
 * Verifiers do NOT persist anything. The route is responsible for
 * upserting platform_connections rows based on the verifier's result.
 */

export {
  verifyBlueskyIdentity,
  normalizeBlueskyHandle,
  isValidBlueskyHandle,
} from "./bluesky";
export type {
  BlueskyVerifierInput,
  BlueskyVerifierResult,
  BlueskyVerifierVerified,
  BlueskyVerifierMismatched,
  BlueskyVerifierError,
  BlueskyVerifierErrorCode,
} from "./bluesky";
