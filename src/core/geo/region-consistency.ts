import type {
  NetworkProfile,
  RegionConsistencyReason,
  RegionConsistencySummary,
  SupportedRegion,
  WorkspaceRegion,
} from "@/types/geo";
import { REGION_METADATA } from "./region-policy";

export interface RegionHistorySample {
  region: SupportedRegion;
  observedAt: string;
}

export interface RegionConsistencyInput {
  workspaceRegion: WorkspaceRegion;
  networkProfile: NetworkProfile | null;
  recentHistory: RegionHistorySample[];
}

const WEIGHTS = {
  timezone_alignment: 0.2,
  publishing_window_consistency: 0.15,
  region_stability: 0.2,
  routing_stability: 0.15,
  cadence_consistency: 0.15,
  language_alignment: 0.15,
} as const;

function timezoneAlignment(w: WorkspaceRegion): RegionConsistencyReason {
  const meta = REGION_METADATA[w.workspaceRegion];
  const ok = w.timezone === meta.defaultTimezone ||
    w.timezone.startsWith(meta.defaultTimezone.split("/")[0]);
  return {
    signal: "timezone_alignment",
    weight: WEIGHTS.timezone_alignment,
    ok,
    detail: ok
      ? `Timezone ${w.timezone} matches ${meta.label}.`
      : `Timezone ${w.timezone} does not match the chosen region.`,
  };
}

function windowConsistency(w: WorkspaceRegion): RegionConsistencyReason {
  const meta = REGION_METADATA[w.workspaceRegion];
  if (w.preferredPublishingWindows.length === 0) {
    return {
      signal: "publishing_window_consistency",
      weight: WEIGHTS.publishing_window_consistency,
      ok: false,
      detail: "No publishing windows set.",
    };
  }
  const ok = w.preferredPublishingWindows.every(
    (win) =>
      win.startHourLocal >= meta.businessHoursStartLocal - 1 &&
      win.endHourLocal <= meta.businessHoursEndLocal + 3,
  );
  return {
    signal: "publishing_window_consistency",
    weight: WEIGHTS.publishing_window_consistency,
    ok,
    detail: ok
      ? "Publishing windows align with regional business hours."
      : "One or more publishing windows fall outside expected regional hours.",
  };
}

function regionStability(input: RegionConsistencyInput): RegionConsistencyReason {
  const distinct = new Set(input.recentHistory.map((h) => h.region));
  distinct.add(input.workspaceRegion.workspaceRegion);
  const ok = distinct.size <= 1;
  return {
    signal: "region_stability",
    weight: WEIGHTS.region_stability,
    ok,
    detail: ok
      ? "Region has been stable across recent operations."
      : `Region switched ${distinct.size - 1} time(s) in the recent window.`,
  };
}

function routingStability(input: RegionConsistencyInput): RegionConsistencyReason {
  const { workspaceRegion: w, networkProfile } = input;
  if (!w.regionalRoutingEnabled) {
    return {
      signal: "routing_stability",
      weight: WEIGHTS.routing_stability,
      ok: true,
      detail: "Regional routing disabled.",
    };
  }
  if (!networkProfile) {
    return {
      signal: "routing_stability",
      weight: WEIGHTS.routing_stability,
      ok: false,
      detail: "Regional routing is enabled but no network profile is attached.",
    };
  }
  const ok = networkProfile.region === w.workspaceRegion && networkProfile.active;
  return {
    signal: "routing_stability",
    weight: WEIGHTS.routing_stability,
    ok,
    detail: ok
      ? "Active network profile matches the workspace region."
      : "Active network profile does not match the workspace region.",
  };
}

function cadenceConsistency(w: WorkspaceRegion): RegionConsistencyReason {
  const ok = w.preferredPublishingWindows.length > 0 &&
    w.preferredPublishingWindows.length <= 4;
  return {
    signal: "cadence_consistency",
    weight: WEIGHTS.cadence_consistency,
    ok,
    detail: ok
      ? "Publishing cadence is calmly bounded."
      : "Cadence is empty or fragmented across too many windows.",
  };
}

function languageAlignment(w: WorkspaceRegion): RegionConsistencyReason {
  const meta = REGION_METADATA[w.workspaceRegion];
  const ok = w.primaryLanguage.startsWith(meta.defaultLanguage.split("-")[0]);
  return {
    signal: "language_alignment",
    weight: WEIGHTS.language_alignment,
    ok,
    detail: ok
      ? `Primary language ${w.primaryLanguage} aligns with ${meta.label}.`
      : `Primary language ${w.primaryLanguage} differs from regional default ${meta.defaultLanguage}.`,
  };
}

export function scoreRegionConsistency(
  input: RegionConsistencyInput,
): RegionConsistencySummary {
  const reasons: RegionConsistencyReason[] = [
    timezoneAlignment(input.workspaceRegion),
    windowConsistency(input.workspaceRegion),
    regionStability(input),
    routingStability(input),
    cadenceConsistency(input.workspaceRegion),
    languageAlignment(input.workspaceRegion),
  ];
  const score = reasons.reduce(
    (acc, r) => acc + (r.ok ? r.weight : 0),
    0,
  );
  const level: RegionConsistencySummary["level"] =
    score >= 0.8 ? "stable" : score >= 0.55 ? "drifting" : "inconsistent";
  const meta = REGION_METADATA[input.workspaceRegion.workspaceRegion];
  const summary =
    level === "stable"
      ? `Stable ${meta.label} operational identity`
      : level === "drifting"
        ? `${meta.label} identity is drifting`
        : `${meta.label} identity is inconsistent`;
  return { score: Number(score.toFixed(2)), level, reasons, summary };
}
