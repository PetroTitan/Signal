import { describe, expect, it } from "vitest";
import { GET, POST } from "./route";

/**
 * Integration coverage for the real MCP endpoint that does NOT require
 * a database: protocol handshake, notifications, malformed input, the
 * GET probe, and the real token mechanism's missing-Authorization
 * path (extractBearer rejects before any DB / service-role read).
 *
 * Token-validated paths (tools/call, invalid-token) are covered at the
 * handler level in `src/mcp/http/handler.test.ts` with injected deps.
 */
function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/mcp/http", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/mcp/http", () => {
  it("initialize returns a JSON-RPC success with MCP capabilities", async () => {
    const res = await POST(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { serverInfo: { name: string }; capabilities: { tools?: unknown }; protocolVersion: string };
    };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result.serverInfo.name).toBe("signal");
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("notifications/initialized returns 202 with an empty body", async () => {
    const res = await POST(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("malformed JSON returns a JSON-RPC parse error", async () => {
    const res = await POST(post("{ not json"));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32700);
  });

  it("a malformed JSON-RPC envelope returns invalid-request", async () => {
    const res = await POST(post({ id: 5, method: "tools/list" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32600);
  });

  it("tools/list without Authorization returns an MCP auth error", async () => {
    const res = await POST(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as {
      error: { code: number; data: { error_code: string } };
    };
    expect(json.error.code).toBe(-32001);
    expect(json.error.data.error_code).toBe("missing_authorization");
  });

  it("an unknown method returns method-not-found", async () => {
    const res = await POST(post({ jsonrpc: "2.0", id: 6, method: "frobnicate" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32601);
  });
});

describe("GET /api/mcp/http", () => {
  it("returns 405 (POST-only, no server-initiated SSE stream)", () => {
    const res = GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
