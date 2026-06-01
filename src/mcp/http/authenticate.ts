import "server-only";
import { extractBearer, hashToken } from "../auth";
import { McpError } from "../errors";
import {
  lookupTokenByHash,
  type OperatorToken,
} from "@/repositories/mcp-server/operator-token-repository";
import { isServiceRoleAvailable } from "@/lib/supabase/service-role";

/**
 * Phase F8 — token authentication for the real MCP endpoint.
 *
 * This reuses the *exact* Signal MCP token mechanism the existing
 * `/api/mcp` dispatcher uses (see `src/mcp/server.ts`):
 *
 *   Authorization: Bearer sigt_<...>
 *     → extractBearer (shape check)
 *     → hashToken (SHA-256)
 *     → lookupTokenByHash (service-role read of mcp_operator_tokens)
 *     → status / expiry checks
 *
 * It is split out so `initialize` and `tools/list` can authenticate
 * without going through the full tool dispatch path, while
 * `tools/call` continues to authenticate inside the unchanged
 * dispatcher. The token table, hashing, and validation rules are
 * identical across both surfaces.
 */

export type McpAuthResult =
  | { ok: true; token: OperatorToken }
  | { ok: false; httpStatus: number; errorCode: string; message: string };

export async function authenticateMcpToken(
  authorization: string | null,
): Promise<McpAuthResult> {
  // 1) Shape + presence. Throws McpError for a missing header or a
  //    malformed "Bearer <token>" value — both map to HTTP 401.
  let plaintext: string;
  try {
    plaintext = extractBearer(authorization);
  } catch (err) {
    if (err instanceof McpError) {
      return {
        ok: false,
        httpStatus: err.httpStatus,
        errorCode: err.code,
        message: err.message,
      };
    }
    throw err;
  }

  // 2) Honest precondition: without the service-role key the bridge
  //    cannot authenticate any token. Surface that rather than
  //    collapsing into "invalid_token".
  if (!isServiceRoleAvailable()) {
    return {
      ok: false,
      httpStatus: 503,
      errorCode: "server_not_configured",
      message:
        "Signal MCP server is not configured. SUPABASE_SERVICE_ROLE_KEY is unset on the server.",
    };
  }

  const tokenHash = await hashToken(plaintext);
  const token = await lookupTokenByHash(tokenHash);
  if (!token) {
    return {
      ok: false,
      httpStatus: 401,
      errorCode: "invalid_token",
      message: "Bearer token is not recognized.",
    };
  }
  if (token.status === "revoked") {
    return {
      ok: false,
      httpStatus: 401,
      errorCode: "token_revoked",
      message: "Token has been revoked.",
    };
  }
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) {
    return {
      ok: false,
      httpStatus: 401,
      errorCode: "token_expired",
      message: "Token has expired.",
    };
  }

  return { ok: true, token };
}
