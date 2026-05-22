import type { SupportedRegion } from "./workspace-region";

export interface RegionalRoutingDecision {
  region: SupportedRegion;
  timezone: string;
  networkProfileId: string | null;
  reason: string;
}

export type RoutingValidationCode =
  | "missing_region"
  | "missing_timezone"
  | "missing_language"
  | "invalid_window"
  | "unsupported_protocol"
  | "invalid_port"
  | "invalid_host"
  | "timezone_region_mismatch"
  | "routing_disabled_with_profile"
  | "geo_mode_inconsistent";

export interface RoutingValidationIssue {
  code: RoutingValidationCode;
  message: string;
  field?: string;
}

export interface RoutingValidationResult {
  ok: boolean;
  issues: RoutingValidationIssue[];
}
