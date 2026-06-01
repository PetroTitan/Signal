import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  handleMcpMessage,
  type DispatchEnvelope,
  type McpHandlerDeps,
} from "./handler";
import { JSON_RPC_ERRORS } from "./jsonrpc";
import type { McpAuthResult } from "./authenticate";

const OK_AUTH: McpAuthResult = { ok: true, token: {} as never };

function envelope(
  partial: Partial<DispatchEnvelope["body"]> & { ok: boolean },
  status = 200,
): DispatchEnvelope {
  return {
    status,
    body: {
      ok: partial.ok,
      tool: partial.tool ?? "signal.workspace.get",
      status: partial.status ?? (partial.ok ? "completed" : "failed"),
      summary: partial.summary ?? "ok",
      data: partial.data ?? {},
      warnings: partial.warnings ?? [],
      requires_user_approval: partial.requires_user_approval ?? false,
      audit_id: partial.audit_id ?? null,
      error_code: partial.error_code,
    },
  };
}

function deps(overrides: Partial<McpHandlerDeps> = {}): McpHandlerDeps {
  return {
    authenticate: async () => OK_AUTH,
    dispatch: async () => envelope({ ok: true }),
    listTools: () => [
      {
        name: "signal.workspace.get",
        description: "Read workspace.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  };
}

describe("initialize", () => {
  it("returns valid MCP server capabilities and echoes the protocol version", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claude-code", version: "1.0" },
        },
      },
      deps: deps(),
    });
    expect(r.status).toBe(200);
    const body = r.body as { result: Record<string, unknown> };
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(body.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: MCP_SERVER_INFO,
    });
    expect(
      (body.result.capabilities as Record<string, unknown>).tools,
    ).toBeDefined();
  });

  it("falls back to the default protocol version when the client omits it", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: { jsonrpc: "2.0", id: 1, method: "initialize" },
      deps: deps(),
    });
    const body = r.body as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
  });
});

describe("notifications", () => {
  it("accepts notifications/initialized with 202 and no body", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: { jsonrpc: "2.0", method: "notifications/initialized" },
      deps: deps(),
    });
    expect(r.status).toBe(202);
    expect(r.body).toBeNull();
  });
});

describe("tools/list", () => {
  it("returns the tool catalog when authenticated", async () => {
    const r = await handleMcpMessage({
      authorization: "Bearer sigt_valid",
      message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      deps: deps(),
    });
    expect(r.status).toBe(200);
    const body = r.body as { result: { tools: unknown[] } };
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools[0]).toMatchObject({
      name: "signal.workspace.get",
      description: expect.any(String),
      inputSchema: expect.objectContaining({ type: "object" }),
    });
  });

  it("returns an MCP auth error when the Authorization header is missing", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      deps: deps({
        authenticate: async () => ({
          ok: false,
          httpStatus: 401,
          errorCode: "missing_authorization",
          message: "Authorization header missing.",
        }),
      }),
    });
    expect(r.status).toBe(401);
    const body = r.body as { error: { code: number; data: { error_code: string } } };
    expect(body.error.code).toBe(JSON_RPC_ERRORS.UNAUTHORIZED);
    expect(body.error.data.error_code).toBe("missing_authorization");
  });

  it("returns an MCP auth error for an invalid token", async () => {
    const r = await handleMcpMessage({
      authorization: "Bearer sigt_bogus",
      message: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      deps: deps({
        authenticate: async () => ({
          ok: false,
          httpStatus: 401,
          errorCode: "invalid_token",
          message: "Bearer token is not recognized.",
        }),
      }),
    });
    expect(r.status).toBe(401);
    const body = r.body as { error: { code: number; data: { error_code: string } } };
    expect(body.error.code).toBe(JSON_RPC_ERRORS.UNAUTHORIZED);
    expect(body.error.data.error_code).toBe("invalid_token");
  });
});

describe("tools/call", () => {
  it("forwards the call to the existing dispatcher and wraps the envelope", async () => {
    const dispatch = vi.fn(async () =>
      envelope({
        ok: true,
        tool: "signal.weekly_plan.current",
        summary: "Read the current weekly plan.",
        data: { plan: { id: "wp_1" } },
        audit_id: "aud_1",
      }),
    );
    const r = await handleMcpMessage({
      authorization: "Bearer sigt_valid",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "signal.weekly_plan.current", arguments: {} },
      },
      deps: deps({ dispatch }),
    });
    expect(dispatch).toHaveBeenCalledWith({
      authorization: "Bearer sigt_valid",
      tool: "signal.weekly_plan.current",
      args: {},
    });
    expect(r.status).toBe(200);
    const result = (r.body as { result: Record<string, unknown> }).result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      tool: "signal.weekly_plan.current",
      audit_id: "aud_1",
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Read the current weekly plan.");
  });

  it("defaults missing arguments to an empty object", async () => {
    const dispatch = vi.fn(async () => envelope({ ok: true }));
    await handleMcpMessage({
      authorization: "Bearer sigt_valid",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "signal.workspace.get" },
      },
      deps: deps({ dispatch }),
    });
    expect(dispatch).toHaveBeenCalledWith({
      authorization: "Bearer sigt_valid",
      tool: "signal.workspace.get",
      args: {},
    });
  });

  it("surfaces requires_user_approval + audit in the result content", async () => {
    const r = await handleMcpMessage({
      authorization: "Bearer sigt_valid",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "signal.weekly_plan.prepare_item",
          arguments: { title: "Hi" },
        },
      },
      deps: deps({
        dispatch: async () =>
          envelope({
            ok: true,
            tool: "signal.weekly_plan.prepare_item",
            summary: "Prepared item pending approval.",
            requires_user_approval: true,
            audit_id: "aud_2",
          }),
      }),
    });
    const result = (r.body as { result: Record<string, unknown> }).result;
    expect(result.structuredContent).toMatchObject({
      requires_user_approval: true,
      audit_id: "aud_2",
    });
    const content = result.content as Array<{ text: string }>;
    expect(content[0].text).toContain("Requires operator approval");
  });

  it("reports a blocked tool as a tool result with isError=true (not a protocol error)", async () => {
    const r = await handleMcpMessage({
      authorization: "Bearer sigt_valid",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "signal.publish.live", arguments: {} },
      },
      deps: deps({
        dispatch: async () =>
          envelope(
            {
              ok: false,
              tool: "signal.publish.live",
              status: "blocked",
              summary: "This tool is explicitly blocked by the Signal MCP policy.",
            },
            403,
          ),
      }),
    });
    expect(r.status).toBe(200);
    const result = (r.body as { result: Record<string, unknown> }).result;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "blocked" });
  });

  it("maps a dispatcher 401 to an MCP auth error", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "signal.workspace.get", arguments: {} },
      },
      deps: deps({
        dispatch: async () =>
          envelope(
            {
              ok: false,
              status: "unauthorized",
              summary: "Authorization header missing.",
              error_code: "missing_authorization",
            },
            401,
          ),
      }),
    });
    expect(r.status).toBe(401);
    const body = r.body as { error: { code: number; data: { error_code: string } } };
    expect(body.error.code).toBe(JSON_RPC_ERRORS.UNAUTHORIZED);
    expect(body.error.data.error_code).toBe("missing_authorization");
  });

  it("rejects a tools/call without a name", async () => {
    const r = await handleMcpMessage({
      authorization: "Bearer sigt_valid",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { arguments: {} },
      },
      deps: deps(),
    });
    const body = r.body as { error: { code: number } };
    expect(body.error.code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
  });
});

describe("protocol errors", () => {
  it("returns method-not-found for an unknown method", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: { jsonrpc: "2.0", id: 9, method: "frobnicate" },
      deps: deps(),
    });
    expect(r.status).toBe(200);
    const body = r.body as { error: { code: number } };
    expect(body.error.code).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });

  it("returns invalid-request for a malformed JSON-RPC envelope", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: { id: 9, method: "tools/list" },
      deps: deps(),
    });
    expect(r.status).toBe(400);
    const body = r.body as { error: { code: number } };
    expect(body.error.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  it("answers ping with an empty result", async () => {
    const r = await handleMcpMessage({
      authorization: null,
      message: { jsonrpc: "2.0", id: 9, method: "ping" },
      deps: deps(),
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 9, result: {} });
  });
});
