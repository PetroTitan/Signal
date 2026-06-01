import { describe, expect, it } from "vitest";
import { BLOCKED_TOOL_NAMES, TOOLS } from "@/mcp/tool-registry";
import { TOOL_INPUT_SCHEMAS, mcpInputSchemaFor } from "./tool-input-schemas";

describe("tool input schema map", () => {
  it("has an inputSchema for every registered tool", () => {
    for (const t of TOOLS) {
      expect(
        TOOL_INPUT_SCHEMAS[t.name],
        `missing inputSchema for ${t.name}`,
      ).toBeDefined();
    }
  });

  it("does not advertise unknown or blocked tool names", () => {
    const registered = new Set(TOOLS.map((t) => t.name));
    for (const name of Object.keys(TOOL_INPUT_SCHEMAS)) {
      expect(registered.has(name), `${name} is not in the registry`).toBe(true);
      expect(BLOCKED_TOOL_NAMES.has(name), `${name} is on the deny-list`).toBe(
        false,
      );
    }
  });

  it("every schema is a JSON-Schema object", () => {
    for (const [name, schema] of Object.entries(TOOL_INPUT_SCHEMAS)) {
      expect(schema.type, `${name} schema must be type=object`).toBe("object");
    }
  });

  it("falls back to a permissive object schema for unknown names", () => {
    expect(mcpInputSchemaFor("signal.does_not_exist")).toEqual({
      type: "object",
    });
  });
});
