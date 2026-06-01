import { NextResponse } from "next/server";
import { dispatch } from "@/mcp/server";
import { authenticateMcpToken } from "@/mcp/http/authenticate";
import { buildMcpToolList } from "@/mcp/http/tool-list";
import { handleMcpMessage } from "@/mcp/http/handler";
import { JSON_RPC_ERRORS, jsonRpcError } from "@/mcp/http/jsonrpc";

/**
 * Phase F8 — real MCP endpoint (Streamable HTTP / JSON-RPC 2.0).
 *
 * This is the endpoint Claude Code / mcp-remote should use:
 *
 *   claude mcp add --transport http signal \
 *     https://signal.webmasterid.com/api/mcp/http \
 *     --header "Authorization: Bearer <SIGNAL_TOKEN>"
 *
 * It speaks JSON-RPC (initialize / notifications/initialized /
 * tools/list / tools/call), authenticates with the existing Signal
 * MCP token mechanism, and forwards each tools/call to the SAME
 * internal dispatcher as the legacy `/api/mcp` custom API. The legacy
 * endpoint is unchanged and remains an internal custom HTTP API — it
 * is NOT MCP and should not be used with mcp-remote.
 *
 * See docs/mcp-server/claude-code-config.md.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return NextResponse.json(
      jsonRpcError(
        null,
        JSON_RPC_ERRORS.PARSE_ERROR,
        "Parse error: request body is not valid JSON.",
      ),
      { status: 400 },
    );
  }

  const result = await handleMcpMessage({
    authorization: request.headers.get("authorization"),
    message,
    deps: {
      authenticate: authenticateMcpToken,
      dispatch,
      listTools: buildMcpToolList,
    },
  });

  // Accepted notification (e.g. notifications/initialized): no body.
  if (result.body === null) {
    return new NextResponse(null, { status: result.status });
  }
  return NextResponse.json(result.body, { status: result.status });
}

/**
 * MCP Streamable HTTP allows a GET to open a server→client SSE stream.
 * Signal does not offer server-initiated streaming, so per the spec we
 * return 405 Method Not Allowed. Tool calls go over POST.
 */
export function GET(): Response {
  return NextResponse.json(
    jsonRpcError(
      null,
      JSON_RPC_ERRORS.INVALID_REQUEST,
      "This MCP endpoint is POST-only (no server-initiated SSE stream). Send JSON-RPC requests via POST.",
    ),
    { status: 405, headers: { Allow: "POST" } },
  );
}
