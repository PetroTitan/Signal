import {
  NETWORK_PROFILE_LIMITS,
  SUPPORTED_PROXY_PROTOCOLS,
  type NetworkProfile,
  type RoutingValidationIssue,
  type RoutingValidationResult,
  type WorkspaceRegion,
} from "@/types/geo";
import { REGION_METADATA } from "./region-policy";

function issue(
  code: RoutingValidationIssue["code"],
  message: string,
  field?: string,
): RoutingValidationIssue {
  return { code, message, field };
}

function isHostnameLike(host: string): boolean {
  if (host.length === 0 || host.length > NETWORK_PROFILE_LIMITS.hostMax) return false;
  return /^[A-Za-z0-9._-]+$/.test(host);
}

export function validateWorkspaceRegion(
  region: WorkspaceRegion,
): RoutingValidationResult {
  const issues: RoutingValidationIssue[] = [];
  if (!region.workspaceRegion) {
    issues.push(
      issue("missing_region", "Pick an operational region for this workspace.", "workspaceRegion"),
    );
  }
  if (!region.timezone) {
    issues.push(
      issue("missing_timezone", "Set a timezone for this workspace.", "timezone"),
    );
  }
  if (!region.primaryLanguage) {
    issues.push(
      issue("missing_language", "Set a primary language.", "primaryLanguage"),
    );
  }
  const meta = REGION_METADATA[region.workspaceRegion];
  if (meta && region.timezone && region.timezone !== meta.defaultTimezone) {
    if (!region.timezone.startsWith(meta.defaultTimezone.split("/")[0])) {
      issues.push(
        issue(
          "timezone_region_mismatch",
          `Timezone "${region.timezone}" does not match the chosen region (${meta.label}).`,
          "timezone",
        ),
      );
    }
  }
  if (region.regionalRoutingEnabled === false && region.networkProfileId) {
    issues.push(
      issue(
        "routing_disabled_with_profile",
        "Regional routing is off but a network profile is attached. Either enable routing or detach the profile.",
        "regionalRoutingEnabled",
      ),
    );
  }
  for (const w of region.preferredPublishingWindows) {
    if (
      w.startHourLocal < 0 ||
      w.startHourLocal > 23 ||
      w.endHourLocal < 1 ||
      w.endHourLocal > 24 ||
      w.endHourLocal <= w.startHourLocal
    ) {
      issues.push(
        issue("invalid_window", `Publishing window "${w.label}" has invalid hours.`),
      );
    }
  }
  if (
    region.geoMode === "local_only" &&
    region.publishingRegion !== region.workspaceRegion
  ) {
    issues.push(
      issue(
        "geo_mode_inconsistent",
        "Local-only mode requires the publishing region to match the workspace region.",
        "publishingRegion",
      ),
    );
  }
  return { ok: issues.length === 0, issues };
}

export function validateNetworkProfile(
  profile: NetworkProfile,
): RoutingValidationResult {
  const issues: RoutingValidationIssue[] = [];
  if (!SUPPORTED_PROXY_PROTOCOLS.includes(profile.protocol)) {
    issues.push(
      issue("unsupported_protocol", "Pick HTTP, HTTPS, or SOCKS5.", "protocol"),
    );
  }
  if (!isHostnameLike(profile.host)) {
    issues.push(
      issue("invalid_host", "Host must look like a hostname or IP.", "host"),
    );
  }
  if (
    !Number.isInteger(profile.port) ||
    profile.port < NETWORK_PROFILE_LIMITS.portMin ||
    profile.port > NETWORK_PROFILE_LIMITS.portMax
  ) {
    issues.push(
      issue("invalid_port", "Port must be between 1 and 65535.", "port"),
    );
  }
  return { ok: issues.length === 0, issues };
}
