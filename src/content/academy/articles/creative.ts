import type { Article } from "../types";

export const creative: Article[] = [
  {
    slug: "creative-approval-workflow",
    section: "creative",
    title: "Creative approval workflow",
    description:
      "Creative assets pass their own readiness and approval checks before a post that uses them can publish.",
    lastUpdated: "2026-06-14",
    overview: [
      "Media attached to a post is treated as creative that has to be ready before the post can go out. Creative readiness is a gate: a post whose creative isn't ready is blocked rather than published with broken or non-compliant media.",
      "This keeps the approval promise honest for media too — you approve content and its creative together, and Signal won't quietly publish a post whose image failed validation.",
    ],
    nextSteps: ["understanding-creative-readiness", "media-validation-rules"],
    related: ["how-approval-works", "media-derivatives"],
    published: true,
  },
  {
    slug: "understanding-creative-readiness",
    section: "creative",
    title: "Understanding creative readiness",
    description:
      "Creative readiness means a post's media has passed validation and been prepared into a provider-safe form. Not-ready creative blocks the post.",
    lastUpdated: "2026-06-14",
    overview: [
      "\"Ready\" creative is media that has passed Signal's validation and been transformed into a provider-safe derivative for the target platform. If creative isn't ready — missing required alt text, an unsupported format, an oversized file that can't be reduced — the post is blocked until it's resolved.",
    ],
    bullets: [
      {
        heading: "Readiness depends on",
        items: [
          "Required alt text being present (accessibility).",
          "A supported image format.",
          "A size the platform will accept (Signal reduces oversized images where it can).",
        ],
      },
    ],
    prerequisites: ["creative-approval-workflow"],
    nextSteps: ["media-validation-rules", "fixing-creative-validation-errors"],
    related: ["media-derivatives"],
    published: true,
  },
  {
    slug: "media-validation-rules",
    section: "creative",
    title: "Media validation rules",
    description:
      "What Signal checks before allowing media to publish: format, alt text, and provider-safe sizing.",
    lastUpdated: "2026-06-14",
    overview: [
      "Before media can publish, Signal validates it. The checks exist to prevent two failure modes: publishing inaccessible media (no alt text) and publishing media a platform will reject (wrong format or too large).",
    ],
    bullets: [
      {
        heading: "Checks",
        items: [
          "Alt text — required where the platform expects it; a missing value blocks the post.",
          "Format — the image must be a supported type.",
          "Size — oversized images are reduced to a provider-safe derivative; if it can't be made compliant, the post is blocked.",
        ],
      },
    ],
    prerequisites: ["understanding-creative-readiness"],
    nextSteps: ["fixing-creative-validation-errors"],
    related: ["media-derivatives", "media-upload-problems"],
    published: true,
  },
  {
    slug: "media-derivatives",
    section: "creative",
    title: "Media derivatives explained",
    description:
      "Signal transcodes your original image into a provider-safe derivative — right format and size for the platform — without altering the original.",
    lastUpdated: "2026-06-14",
    overview: [
      "A derivative is a processed copy of your image prepared for a specific platform: re-encoded to a supported format and compressed under the platform's size ceiling. Signal generates the derivative at publish time so your original stays untouched and each platform gets media it will accept.",
      "This is why an image that's too large to upload directly can still publish through Signal — the derivative is reduced to a provider-safe size before the post goes out.",
    ],
    prerequisites: ["media-validation-rules"],
    related: ["understanding-creative-readiness", "publish-to-bluesky", "x-publishing-workflow"],
    published: true,
  },
  {
    slug: "fixing-creative-validation-errors",
    section: "creative",
    title: "Fixing creative validation errors",
    description:
      "How to resolve a blocked post caused by creative: add alt text, use a supported format, or replace an image that can't be made compliant.",
    lastUpdated: "2026-06-14",
    overview: [
      "If a post is blocked on creative, the fix is usually quick. The block tells you what failed; resolve it and the post can move forward.",
    ],
    troubleshooting: [
      {
        problem: "Blocked: missing alt text.",
        fix: "Add descriptive alt text to the image. Signal blocks rather than publishing inaccessible media.",
      },
      {
        problem: "Blocked: unsupported format.",
        fix: "Replace the asset with a supported image format and re-attach it.",
      },
      {
        problem: "Blocked: image too large.",
        fix: "Signal reduces oversized images automatically, but an extreme file may still exceed limits. Replace it with a smaller source image.",
      },
    ],
    prerequisites: ["media-validation-rules"],
    related: ["media-upload-problems", "media-derivatives"],
    published: true,
  },
];
