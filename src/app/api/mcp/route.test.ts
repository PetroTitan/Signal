import { describe, expect, it } from "vitest";
import { POST } from "./route";

/**
 * Guard: the legacy `/api/mcp` custom HTTP API must remain UNCHANGED
 * by the new MCP endpoint work. Both of these branches return before
 * the dispatcher runs, so they exercise the public contract without a
 * database — the same custom (non-MCP) envelope the bridge has always
 * returned. (A JSON-RPC `initialize` body has no top-level `tool`, so
 * this endpoint correctly rejects it — proving it is NOT an MCP server.)
 */
describe("legacy /api/mcp custom endpoint is unchanged", () => {
  it("rejects a body without a 'tool' string", async () => {
    const req = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.summary).toBe("Request must include a 'tool' string.");
  });

  it("rejects a JSON-RPC initialize body (no top-level tool)", async () => {
    const req = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.summary).toBe("Request must include a 'tool' string.");
  });

  it("rejects malformed JSON", async () => {
    const req = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.summary).toBe("Request body is not valid JSON.");
  });
});
