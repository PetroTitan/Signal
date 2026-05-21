import type { PlatformId } from "@/types";

export const TRUST = {
  heading: "Signal never asks for your platform password.",
  body: "Signal helps prepare and operate accounts; it does not bypass platform systems. We never request passwords, cookies, session tokens, 2FA codes, or recovery codes. Connection happens only through official OAuth, when integration is enabled.",
  approval:
    "Human approval remains central to the workflow. Signal flags, recommends, and schedules — you decide.",
  oauthShortHeading: (platform: PlatformId | "google") =>
    `${platformName(platform)} OAuth — not yet enabled`,
  oauthShortBody: (platform: PlatformId | "google") =>
    `When ${platformName(platform)} OAuth ships, this surface will connect through the platform's own authorization flow. No password, no cookies, no session tokens.`,
  oauthShortAction: (platform: PlatformId | "google") =>
    `Connect via ${platformName(platform)} OAuth (not yet available)`,
  notListed: [
    "Signal does not auto-publish.",
    "Signal does not auto-comment.",
    "Signal does not auto-index or auto-update content.",
    "Signal does not use anti-detect browsers, proxies, or fingerprint randomization.",
    "Signal does not manage farms of synthetic accounts.",
  ],
};

export function platformName(platform: PlatformId | "google"): string {
  return platform === "x"
    ? "X"
    : platform === "reddit"
      ? "Reddit"
      : platform === "linkedin"
        ? "LinkedIn"
        : "Google";
}
