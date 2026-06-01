import { describe, expect, it } from "vitest";
import {
  JSON_RPC_ERRORS,
  isNotification,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpcMessage,
} from "./jsonrpc";

describe("parseJsonRpcMessage", () => {
  it("accepts a well-formed request", () => {
    const r = parseJsonRpcMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.method).toBe("tools/list");
      expect(r.value.id).toBe(7);
      expect(isNotification(r.value)).toBe(false);
    }
  });

  it("treats a missing id as a notification", () => {
    const r = parseJsonRpcMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(isNotification(r.value)).toBe(true);
  });

  it("rejects a payload without jsonrpc=2.0 as invalid request", () => {
    const r = parseJsonRpcMessage({ id: 1, method: "initialize" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
      expect(r.id).toBe(1);
    }
  });

  it("rejects a payload without a method", () => {
    const r = parseJsonRpcMessage({ jsonrpc: "2.0", id: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  it("rejects a top-level array (no batching)", () => {
    const r = parseJsonRpcMessage([{ jsonrpc: "2.0", method: "ping" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  it("rejects a non-object body", () => {
    const r = parseJsonRpcMessage("hello");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.id).toBe(null);
  });
});

describe("jsonRpc builders", () => {
  it("builds a success envelope", () => {
    expect(jsonRpcResult(1, { a: 1 })).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { a: 1 },
    });
  });

  it("builds an error envelope with optional data", () => {
    expect(jsonRpcError(2, -32601, "nope", { hint: "x" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "nope", data: { hint: "x" } },
    });
  });

  it("omits data when not provided", () => {
    const e = jsonRpcError(null, -32700, "parse");
    expect(e.error).not.toHaveProperty("data");
  });
});
