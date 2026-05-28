/**
 * Phase F4.1 — founder-readable failure messages.
 *
 * Publishers return PublishOutcome objects whose reasonCode is a
 * machine-readable enum and reasonDetail is a short, often
 * technical, string ("Reddit returned 401", "dev.to validation: tag
 * blocked"). This helper rewraps them into a sentence a founder
 * can act on without scaring them.
 *
 * Bad:  "PLATFORM EXECUTION FAILURE"
 * Good: "dev.to refused this post. Check the article formatting and try again."
 */

import type { PublishReasonCode } from "./publishing-types";

export interface FriendlyFailure {
  /** Short headline, suitable for an amber strip. */
  title: string;
  /** Optional one-sentence advice on what to do next. */
  advice: string;
}

export function friendlyFailure(input: {
  platform: string;
  reasonCode: PublishReasonCode | string | null;
  reasonDetail: string | null;
}): FriendlyFailure {
  const label = friendlyPlatformLabel(input.platform);
  const detail = input.reasonDetail?.trim();

  switch (input.reasonCode) {
    case "missing_api_key":
      return {
        title: `${label} isn't connected yet.`,
        advice: "Add the API key in your environment, then try again.",
      };
    case "missing_publication_id":
      return {
        title: `${label} needs a publication selected.`,
        advice:
          "Set the Hashnode publication in your environment, then try again.",
      };
    case "missing_identifier":
      return {
        title: `${label} isn't connected yet.`,
        advice:
          "Set the Bluesky identifier and app-password in your environment.",
      };
    case "platform_unauthorized":
      return {
        title: `${label} rejected the connection.`,
        advice:
          "The API key may have expired or been revoked. Re-add it and try again.",
      };
    case "platform_rate_limited":
      return {
        title: `${label} asked us to slow down.`,
        advice: "Wait a few minutes, then try again.",
      };
    case "platform_api_error":
      return {
        title: `${label} refused this post.`,
        advice: detail
          ? `Reason: ${detail}.`
          : "Check the post formatting and try again.",
      };
    case "missing_title":
      return {
        title: "This post needs a title.",
        advice: "Add a title in the compose sheet.",
      };
    case "missing_body":
      return {
        title: "This post needs a body.",
        advice: "Write the post content in the compose sheet.",
      };
    case "missing_subreddit":
      return {
        title: "This Reddit post needs a subreddit.",
        advice: "Pick a subreddit in the compose sheet.",
      };
    case "duplicate_post":
      return {
        title: `${label} already has this post.`,
        advice:
          "Signal recently published the same content. Edit the post first if you really want to publish it again.",
      };
    case "body_too_long":
      return {
        title: `This post is too long for ${label}.`,
        advice: "Trim the body, then try again.",
      };
    case "cadence_cooldown":
      return {
        title: `${label} was used recently.`,
        advice: "Waiting a bit longer is recommended before publishing again.",
      };
    case "oauth_not_connected":
    case "oauth_token_not_stored":
      return {
        title: `${label} connection is missing.`,
        advice: "Reconnect on the Accounts page, then try again.",
      };
    case "oauth_reauthorization_required":
      return {
        title: `${label} needs to be reconnected.`,
        advice:
          "Your access was revoked or expired beyond refresh. Reconnect this identity on the Accounts page, then try again.",
      };
    // Phase F9 — X automated publishing reason codes. Each maps to a
    // short founder-readable line; the technical detail (e.g. X's
    // error description) is appended via `detail` when present.
    case "x_token_missing":
    case "x_token_invalid":
      return {
        title: `${label} connection is missing or invalid.`,
        advice:
          "Reconnect this X identity from the Accounts page so a fresh access token is stored.",
      };
    case "x_rate_limited":
      return {
        title: `${label} asked us to slow down.`,
        advice: "Wait a few minutes, then try again.",
      };
    case "x_validation_error":
      return {
        title: `${label} refused this post.`,
        advice: detail
          ? `Reason: ${detail}.`
          : "Check the post text and try again.",
      };
    case "x_provider_unavailable":
      return {
        title: `${label} is temporarily unavailable.`,
        advice: "Try again in a moment.",
      };
    case "x_network_error":
      return {
        title: `${label} didn't respond.`,
        advice: "Try again in a moment.",
      };
    case "x_token_refresh_transient":
      return {
        title: `${label} token refresh hit a transient issue.`,
        advice:
          "The scheduler will retry on the next tick automatically — no action needed unless the error persists.",
      };
    case "x_media_upload_unavailable":
      return {
        title: `${label} media upload is unavailable.`,
        advice:
          "X media upload is unavailable for the current X API tier or scope. Text publishing may still work; image publishing requires media upload access. Reconnect with the media.write scope or upgrade the X API tier.",
      };
    case "x_media_upload_failed":
      return {
        title: `${label} couldn't upload the image.`,
        advice: detail
          ? `Reason: ${detail}. The post was not published — Signal does not silently downgrade to text-only when an image was attached.`
          : "Re-upload the creative or attach without an image.",
      };
    case "x_api_error":
      return {
        title: `${label} returned an unexpected response.`,
        advice: detail ? `Reason: ${detail}.` : "Try again in a moment.",
      };
    default:
      return {
        title: `${label} didn't publish this post.`,
        advice: detail ? `Reason: ${detail}.` : "Try again in a moment.",
      };
  }
}

function friendlyPlatformLabel(platform: string): string {
  switch (platform) {
    case "devto":
      return "dev.to";
    case "hashnode":
      return "Hashnode";
    case "bluesky":
      return "Bluesky";
    case "reddit":
      return "Reddit";
    case "x":
      return "X";
    case "linkedin":
      return "LinkedIn";
    default:
      return platform || "the platform";
  }
}
