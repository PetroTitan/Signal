import type { Section } from "./types";

/**
 * Top-level Academy sections, in sidebar order + grouping. The sidebar
 * shows a section only when it has at least one published article.
 */
export const SECTIONS: Section[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    blurb: "What Signal is and how to go from zero to your first scheduled post.",
    order: 1,
    group: "Guides",
  },
  {
    id: "weekly-plans",
    title: "Weekly Plans",
    blurb: "The weekly planning surface: queue, approval, draft, and carry-over.",
    order: 2,
    group: "Guides",
  },
  {
    id: "publishing",
    title: "Publishing",
    blurb: "How the scheduler publishes, and the reliability system behind it.",
    order: 3,
    group: "Guides",
  },
  {
    id: "creative",
    title: "Creative Workflow",
    blurb: "Uploading assets, creative approval, validation, and derivatives.",
    order: 4,
    group: "Guides",
  },
  {
    id: "results",
    title: "Results & Metrics",
    blurb: "Verified metrics, refresh, and Results Intelligence — never estimates.",
    order: 5,
    group: "Guides",
  },
  {
    id: "bluesky",
    title: "Bluesky",
    blurb: "Connect, publish, threads, and verified metrics on Bluesky.",
    order: 6,
    group: "Platforms",
  },
  {
    id: "reddit",
    title: "Reddit",
    blurb: "Connect, publishing workflow, API limits, and metrics on Reddit.",
    order: 7,
    group: "Platforms",
  },
  {
    id: "x",
    title: "X",
    blurb: "Connect, publishing, media, and metrics availability on X.",
    order: 8,
    group: "Platforms",
  },
  {
    id: "devto",
    title: "dev.to",
    blurb: "Connect and publish articles to dev.to, plus metrics.",
    order: 9,
    group: "Platforms",
  },
  {
    id: "hashnode",
    title: "Hashnode",
    blurb: "Connect, publish, and metrics availability on Hashnode.",
    order: 10,
    group: "Platforms",
  },
  {
    id: "teams",
    title: "Teams",
    blurb: "Invitations, roles, ownership transfer, and workspace permissions.",
    order: 11,
    group: "Workspace",
  },
  {
    id: "notifications",
    title: "Notifications",
    blurb: "The notification center, digests, Telegram delivery, and preferences.",
    order: 12,
    group: "Workspace",
  },
  {
    id: "mcp",
    title: "MCP",
    blurb: "Connect Signal to Claude via the Model Context Protocol, safely.",
    order: 13,
    group: "Workspace",
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    blurb: "Fix authentication, publishing, media, and MCP problems.",
    order: 14,
    group: "Support",
  },
  {
    id: "use-cases",
    title: "Use Cases",
    blurb: "How different teams use Signal — workflow, benefits, and limits.",
    order: 15,
    group: "Discover",
  },
  {
    id: "trust",
    title: "Trust & Safety",
    blurb: "Security, the approval model, reliability, and data handling.",
    order: 16,
    group: "Discover",
  },
];

export const SECTION_GROUPS = ["Guides", "Platforms", "Workspace", "Support", "Discover"];
