import "server-only";
import { TOOLS } from "../tool-registry";
import { mcpInputSchemaFor } from "./tool-input-schemas";
import type { McpToolDescriptor } from "./handler";

/**
 * Phase F8 — build the MCP `tools/list` catalog from the live Signal
 * tool registry. Each entry pairs the registry's name + description
 * with the declarative JSON Schema from `tool-input-schemas.ts`.
 *
 * Blocked tool names are intentionally NOT advertised — they only
 * exist as an explicit deny-list inside the dispatcher.
 */
export function buildMcpToolList(): McpToolDescriptor[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: mcpInputSchemaFor(t.name),
  }));
}
