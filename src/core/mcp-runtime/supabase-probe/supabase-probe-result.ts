/**
 * Phase E2.7 — Supabase probe result helpers.
 */

import type {
  SupabaseProbeCapability,
  SupabaseProbeCapabilityResults,
  SupabaseProbeCapabilityVerdict,
  SupabaseProbeResult,
} from "./supabase-probe-types";
import { SUPABASE_PROBE_CAPABILITIES } from "./supabase-probe-types";

export function emptyCapabilityResults(): SupabaseProbeCapabilityResults {
  return SUPABASE_PROBE_CAPABILITIES.reduce((acc, cap) => {
    acc[cap] = "not_tested";
    return acc;
  }, {} as SupabaseProbeCapabilityResults);
}

export function deriveProbeStatus(
  capabilities: SupabaseProbeCapabilityResults,
): "healthy" | "degraded" | "failed" {
  const values = Object.values(capabilities);
  const verified = values.filter((v) => v === "verified").length;
  const missing = values.filter((v) => v === "missing").length;
  if (missing === 0 && verified === values.length) return "healthy";
  if (verified > 0) return "degraded";
  return "failed";
}

export function setCapability(
  results: SupabaseProbeCapabilityResults,
  capability: SupabaseProbeCapability,
  verdict: SupabaseProbeCapabilityVerdict,
): SupabaseProbeCapabilityResults {
  return { ...results, [capability]: verdict };
}

export interface ProbeResultSummary {
  verifiedCount: number;
  missingCount: number;
  notTestedCount: number;
  total: number;
}

export function summarize(
  capabilities: SupabaseProbeCapabilityResults,
): ProbeResultSummary {
  const values = Object.values(capabilities);
  return {
    verifiedCount: values.filter((v) => v === "verified").length,
    missingCount: values.filter((v) => v === "missing").length,
    notTestedCount: values.filter((v) => v === "not_tested").length,
    total: values.length,
  };
}

export function isHealthy(result: SupabaseProbeResult): boolean {
  return result.status === "healthy";
}
