/**
 * Phase E2.7 — derive a connector-level health verdict from a probe
 * result. Used by the /settings/mcp connector card.
 */

import type { McpProbeHealth } from "@/lib/supabase/types";
import type { SupabaseProbeResult } from "./supabase-probe-types";

export function probeHealth(result: SupabaseProbeResult | null): McpProbeHealth {
  if (!result) return "unknown";
  switch (result.status) {
    case "healthy":
      return "healthy";
    case "degraded":
      return "degraded";
    case "failed":
      return "failed";
  }
}

/**
 * Operator-friendly summary for the card.
 */
export function probeSummary(result: SupabaseProbeResult | null): string {
  if (!result) return "No probe run yet.";
  const verified = Object.values(result.capabilities).filter(
    (v) => v === "verified",
  ).length;
  const total = Object.values(result.capabilities).length;
  if (result.status === "healthy") {
    return `DB probe healthy — ${verified}/${total} capabilities verified.`;
  }
  if (result.status === "degraded") {
    return `DB probe degraded — ${verified}/${total} capabilities verified.`;
  }
  return `DB probe failed — ${verified}/${total} capabilities verified.`;
}

/**
 * Honest status label derived from `mode + status`. The probe never
 * claims "MCP connected" when running in `internal_db_probe` mode.
 */
export function probeStatusLabel(
  result: SupabaseProbeResult | null,
): string {
  if (!result) return "Not probed yet";
  if (result.mode === "internal_db_probe") {
    if (result.status === "healthy") return "DB probe healthy";
    if (result.status === "degraded") return "DB probe degraded";
    return "DB probe failed";
  }
  if (result.mode === "operator_bridge") {
    if (result.status === "healthy") return "MCP probe healthy (operator bridge)";
    return "MCP probe degraded (operator bridge)";
  }
  // direct_mcp
  if (result.status === "healthy") return "Connected";
  return result.status === "degraded" ? "Degraded" : "Failed";
}
