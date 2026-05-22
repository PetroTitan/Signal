/**
 * Per-platform capability matrix.
 *
 * Capabilities with prefix `future_` are intentionally not enabled in
 * Phase E3. They appear in the matrix so the UI can render the
 * roadmap and so the contract layer can refuse them today.
 */

import type { OAuthPlatform } from "./oauth-types";

export const OAUTH_CAPABILITIES = [
  "read_profile",
  "future_publish_post",
  "future_publish_comment",
  "future_thread_support",
  "future_company_page_support",
] as const;
export type OAuthCapability = (typeof OAUTH_CAPABILITIES)[number];

export const OAUTH_CAPABILITY_LABELS: Record<OAuthCapability, string> = {
  read_profile: "Read profile",
  future_publish_post: "Publish a post (future)",
  future_publish_comment: "Publish a comment (future)",
  future_thread_support: "Thread support (future)",
  future_company_page_support: "Company page support (future)",
};

export const PLATFORM_OAUTH_CAPABILITIES: Record<
  OAuthPlatform,
  OAuthCapability[]
> = {
  reddit: ["read_profile", "future_publish_post", "future_publish_comment"],
  x: ["read_profile", "future_publish_post", "future_thread_support"],
  linkedin: [
    "read_profile",
    "future_publish_post",
    "future_company_page_support",
  ],
};

export function isPublishingCapability(c: OAuthCapability): boolean {
  return (
    c === "future_publish_post" ||
    c === "future_publish_comment" ||
    c === "future_thread_support" ||
    c === "future_company_page_support"
  );
}
