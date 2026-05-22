import type { SupportedChannel } from "./platform-capabilities";

export interface ScopePlan {
  scope: string;
  label: string;
  required: boolean;
  rationale: string;
}

export const PLANNED_OAUTH_SCOPES: Record<SupportedChannel, ScopePlan[]> = {
  reddit: [
    {
      scope: "identity",
      label: "Identity",
      required: true,
      rationale: "Confirm which Reddit account is connected.",
    },
    {
      scope: "read",
      label: "Read content",
      required: false,
      rationale:
        "Read subreddit metadata and the account's own activity for cadence checks.",
    },
    {
      scope: "submit",
      label: "Submit posts and comments",
      required: false,
      rationale:
        "Optional. Only needed when the founder enables publishing.",
    },
  ],
  x: [
    {
      scope: "users.read",
      label: "Read profile",
      required: true,
      rationale: "Confirm which account is connected and read its handle.",
    },
    {
      scope: "tweet.read",
      label: "Read posts",
      required: false,
      rationale: "Cadence checks against the account's own posts.",
    },
    {
      scope: "tweet.write",
      label: "Publish posts",
      required: false,
      rationale:
        "Optional. Only requested when the founder enables publishing.",
    },
  ],
  linkedin: [
    {
      scope: "r_liteprofile",
      label: "Read profile",
      required: true,
      rationale: "Identify which LinkedIn account is connected.",
    },
    {
      scope: "w_member_social",
      label: "Publish on the member's behalf",
      required: false,
      rationale:
        "Optional. Only requested if publishing is enabled for this account.",
    },
  ],
  google: [
    {
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      label: "Search Console (read-only)",
      required: true,
      rationale: "Read visibility data for the connected property.",
    },
  ],
};

export function isPublishingScope(scope: string): boolean {
  return (
    scope === "submit" ||
    scope === "tweet.write" ||
    scope === "w_member_social"
  );
}
