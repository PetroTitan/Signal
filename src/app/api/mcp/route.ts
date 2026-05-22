import { NextResponse } from "next/server";
import { dispatch } from "@/mcp/server";

/**
 * Phase F0 — Signal MCP HTTP bridge.
 *
 * GET  /api/mcp           — discovery: lists tools, scopes, and the
 *                           "blocked" deny-list. Always public; never
 *                           requires auth.
 *
 * POST /api/mcp           — invoke a single tool. Body shape:
 *                             { "tool": "signal.<name>", "args": {} }
 *                           Auth: Authorization: Bearer <token>
 *
 * The MCP transport is the Signal-MCP HTTP bridge (POST / JSON), not
 * the native MCP streaming protocol. Clients that speak MCP over HTTP
 * can wrap each tool call as a single POST. See
 * docs/mcp-server/signal-mcp-server.md for the contract.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const { TOOLS, BLOCKED_TOOL_NAMES } = await import("@/mcp/tool-registry");
  const { ALLOWED_SCOPES, BLOCKED_SCOPES, SCOPE_LABELS } = await import(
    "@/mcp/permissions"
  );
  return NextResponse.json({
    server: "signal-mcp-http-bridge",
    version: "f0",
    transport: "http_bridge",
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      required_scopes: t.requiredScopes,
      risk_level: t.riskLevel,
      approval_mode: t.approvalMode,
      writes_database: t.writesDatabase,
      touches_production: t.touchesProduction,
    })),
    blocked_tools: Array.from(BLOCKED_TOOL_NAMES),
    allowed_scopes: ALLOWED_SCOPES.map((s) => ({
      scope: s,
      description: SCOPE_LABELS[s],
    })),
    blocked_scopes: BLOCKED_SCOPES,
  });
}

export async function POST(request: Request) {
  let body: { tool?: string; args?: unknown };
  try {
    body = (await request.json()) as { tool?: string; args?: unknown };
  } catch {
    return NextResponse.json(
      {
        ok: false,
        tool: "(unknown)",
        status: "failed",
        summary: "Request body is not valid JSON.",
        data: {},
        warnings: [],
        requires_user_approval: false,
        audit_id: null,
      },
      { status: 400 },
    );
  }
  if (!body.tool || typeof body.tool !== "string") {
    return NextResponse.json(
      {
        ok: false,
        tool: "(unknown)",
        status: "failed",
        summary: "Request must include a 'tool' string.",
        data: {},
        warnings: [],
        requires_user_approval: false,
        audit_id: null,
      },
      { status: 400 },
    );
  }
  const authorization = request.headers.get("authorization");
  const result = await dispatch({
    authorization,
    tool: body.tool,
    args: body.args,
  });
  return NextResponse.json(result.body, { status: result.status });
}
