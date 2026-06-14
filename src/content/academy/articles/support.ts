import type { Article } from "../types";

export const support: Article[] = [
  {
    slug: "failed-posts",
    section: "troubleshooting",
    title: "Failed posts",
    description:
      "Diagnose and recover a failed post: read the recorded reason, fix the cause, and retry — without bypassing approval.",
    lastUpdated: "2026-06-14",
    overview: [
      "A failed post is visible and recoverable. Signal records why each failure happened, so recovery starts with reading the reason rather than guessing.",
    ],
    steps: [
      { title: "Open the failed item", body: "Signal shows the recorded failure reason — a platform error, a rejected payload, or an expired connection." },
      { title: "Fix the cause", body: "Reconnect an expired account, adjust rejected content, or wait out a rate limit." },
      { title: "Retry", body: "The retry returns the item to scheduled with a fresh attempt budget. Approval still stands, so this never bypasses the gate." },
    ],
    troubleshooting: [
      { problem: "It keeps failing the same way.", fix: "The cause is permanent (e.g. a malformed request or a subreddit rule). Change the content or target, not just retry." },
      { problem: "Not sure if it partially published.", fix: "If the item was a stale claim, check the platform first — it may already be live. See Understanding stale claims." },
    ],
    related: ["understanding-failed-posts", "understanding-stale-claims", "retry-and-backoff"],
    published: true,
  },
  {
    slug: "bluesky-authentication-problems",
    section: "troubleshooting",
    title: "Bluesky authentication problems",
    description:
      "Fix Bluesky connection issues: app-password mistakes, handle mismatches, and expired sessions.",
    lastUpdated: "2026-06-14",
    overview: [
      "Bluesky auth issues almost always trace back to the app password or a handle mismatch between the credential and the identity. Work through the cases below in order before reconnecting from scratch.",
    ],
    troubleshooting: [
      { problem: "\"credentials missing\".", fix: "The app password was blank. Generate a new app password in Bluesky settings and paste it." },
      { problem: "Handle mismatch warning.", fix: "The credential resolved to a different account than the identity's handle. Fix the handle or reconnect with the right account's app password." },
      { problem: "Publishing started failing after working.", fix: "The session may have expired or the app password was revoked in Bluesky. Reconnect to refresh it." },
    ],
    related: ["connect-bluesky", "publish-to-bluesky"],
    published: true,
  },
  {
    slug: "media-upload-problems",
    section: "troubleshooting",
    title: "Media upload problems",
    description:
      "Resolve blocked or rejected media: alt text, format, and oversized images that can't be reduced to a provider-safe size.",
    lastUpdated: "2026-06-14",
    overview: [
      "Media problems surface as a blocked post with a specific reason — missing alt text, an unsupported format, or a file too large to make provider-safe. The fix follows directly from the reason shown.",
    ],
    troubleshooting: [
      { problem: "Blocked: missing alt text.", fix: "Add alt text. Signal blocks inaccessible media rather than publishing it." },
      { problem: "Blocked: unsupported format.", fix: "Use a supported image format and re-attach." },
      { problem: "Blocked: too large.", fix: "Signal reduces oversized images automatically, but an extreme file may still exceed limits. Use a smaller source image." },
    ],
    related: ["media-validation-rules", "fixing-creative-validation-errors", "media-derivatives"],
    published: true,
  },
  {
    slug: "notification-problems",
    section: "troubleshooting",
    title: "Notification problems",
    description:
      "Why a digest didn't arrive, why a channel is skipped, and why notifications stay unread until you act.",
    lastUpdated: "2026-06-14",
    overview: [
      "Most notification questions turn out to be intentional, by-design behaviors rather than bugs — especially around empty digests and read state. Here are the common ones and why they happen.",
    ],
    troubleshooting: [
      { problem: "No digest arrived.", fix: "Check cadence isn't \"disabled\", and that a channel is enabled. An empty digest (nothing to report) is intentionally not sent." },
      { problem: "Telegram digest skipped.", fix: "The bot token or target chat isn't configured. The channel reports \"not configured\" and is skipped rather than failing the job." },
      { problem: "Notifications stay unread after a digest.", fix: "By design — sending a digest never marks notifications as read. Mark them read in the notification center." },
    ],
    related: ["scheduled-digests", "telegram-notifications", "notification-preferences"],
    published: true,
  },
];
