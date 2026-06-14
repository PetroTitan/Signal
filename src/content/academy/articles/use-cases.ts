import type { Article } from "../types";

export const useCases: Article[] = [
  {
    slug: "signal-for-saas-founders",
    section: "use-cases",
    title: "Signal for SaaS founders",
    description:
      "Plan a week of cross-platform posts, approve in one pass, and publish reliably — without a marketing hire or a posting habit.",
    lastUpdated: "2026-06-14",
    overview: [
      "A solo or small-team SaaS founder rarely has time for daily posting. Signal turns distribution into a weekly decision: plan the week, approve once, and let the scheduler publish across the platforms you've connected.",
    ],
    bullets: [
      {
        heading: "The workflow",
        items: [
          "Draft a week of posts in the weekly plan (changelog notes, lessons, launches).",
          "Approve in one calm pass — the single gate.",
          "The scheduler publishes to Bluesky, X, Reddit, dev.to, or Hashnode as you've connected them.",
          "Results shows verified engagement where the platform exposes it.",
        ],
      },
      {
        heading: "Benefits",
        items: ["One weekly decision instead of daily posting.", "Reliable publishing with retries — no babysitting.", "Honest metrics; no vanity numbers."],
      },
      {
        heading: "Limitations",
        items: [
          "Signal doesn't write your content for you or auto-publish.",
          "Metrics depend on what each platform exposes (X requires a paid tier; see Supported metrics).",
        ],
      },
    ],
    related: ["getting-started", "understanding-the-workflow", "supported-metrics-by-platform"],
    published: true,
  },
  {
    slug: "signal-for-indie-hackers",
    section: "use-cases",
    title: "Signal for indie hackers",
    description:
      "Build in public across Bluesky, X, and dev.to on a calm weekly cadence, with verified results and zero growth-hacking nonsense.",
    lastUpdated: "2026-06-14",
    overview: [
      "Building in public works best as a sustainable habit, not a daily scramble. Signal lets an indie hacker batch a week of build-in-public updates, approve them once, and publish on a steady cadence.",
    ],
    bullets: [
      {
        heading: "The workflow",
        items: [
          "Collect the week's updates as items.",
          "Approve and stagger them across the week.",
          "Cross-post technical write-ups to dev.to and short updates to Bluesky/X.",
          "Track verified engagement on Bluesky, Reddit, and dev.to.",
        ],
      },
      {
        heading: "Limitations",
        items: ["No automation around comments or replies.", "No fabricated reach — what you see is what the API returned."],
      },
    ],
    related: ["getting-started", "publish-articles-to-devto", "results-intelligence"],
    published: true,
  },
  {
    slug: "signal-for-agencies",
    section: "use-cases",
    title: "Signal for agencies",
    description:
      "Run multiple client workspaces with roles, a reviewer approval gate, and an audit trail of who approved what.",
    lastUpdated: "2026-06-14",
    overview: [
      "Agencies need separation between clients and a clear approval chain. Each client is a workspace with its own connected accounts, plan, and results. Roles let strategists prepare work and clients (or leads) approve it.",
    ],
    bullets: [
      {
        heading: "The workflow",
        items: [
          "One workspace per client; data is scoped per workspace.",
          "Editors prepare the week; reviewers approve content and creative.",
          "Approval is audited — you can see who approved what.",
          "Ownership can transfer cleanly if an account changes hands.",
        ],
      },
      {
        heading: "Limitations",
        items: ["No cross-workspace bulk publishing — each client is approved on its own.", "Reviewers can approve but not change settings or members."],
      },
    ],
    related: ["workspace-permissions", "reviewer-role", "ownership-transfer"],
    published: true,
  },
  {
    slug: "signal-for-content-marketing-teams",
    section: "use-cases",
    title: "Signal for content marketing teams",
    description:
      "Coordinate a weekly content pipeline across writers and reviewers, publish to blogs and social, and report on verified engagement.",
    lastUpdated: "2026-06-14",
    overview: [
      "A content team can use Signal as a shared weekly pipeline: writers draft, reviewers approve, and the scheduler distributes to long-form (dev.to, Hashnode) and social (Bluesky, X, Reddit) targets.",
    ],
    bullets: [
      {
        heading: "The workflow",
        items: [
          "Writers add items to the weekly plan.",
          "Reviewers approve content and creative at the single gate.",
          "Articles publish to dev.to/Hashnode; social posts to Bluesky/X/Reddit.",
          "Results Intelligence summarizes top posts and platforms from verified data.",
        ],
      },
      {
        heading: "Limitations",
        items: ["Signal reports verified engagement only — no estimated reach or impressions.", "Hashnode analytics aren't integrated yet (shown as Unavailable)."],
      },
    ],
    related: ["how-approval-works", "results-intelligence", "supported-metrics-by-platform"],
    published: true,
  },
  {
    slug: "signal-for-ai-startups",
    section: "use-cases",
    title: "Signal for AI startups",
    description:
      "Let Claude help prepare a week of content through the MCP bridge — then approve every item yourself before it ships.",
    lastUpdated: "2026-06-14",
    overview: [
      "AI startups often live in Claude already. Signal's MCP bridge lets an assistant read your workspace and prepare a week of posts — but the approval gate still holds, so you review everything before it publishes.",
    ],
    bullets: [
      {
        heading: "The workflow",
        items: [
          "Connect Claude to Signal with a scoped MCP token.",
          "Have the assistant prepare items into the weekly plan.",
          "Approve them yourself — MCP work passes the same gate.",
          "Publish and measure with verified metrics.",
        ],
      },
      {
        heading: "Limitations",
        items: ["The assistant cannot publish without your approval.", "Every MCP tool call is scoped to one workspace and audited."],
      },
    ],
    related: ["what-is-mcp", "mcp-approval-workflow", "mcp-security-model"],
    published: true,
  },
];
