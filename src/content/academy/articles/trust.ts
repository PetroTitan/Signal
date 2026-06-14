import type { Article } from "../types";

export const trust: Article[] = [
  {
    slug: "security-overview",
    section: "trust",
    title: "Security overview",
    description:
      "Signal is credential-minimal and OAuth-first. It never asks for platform passwords, cookies, 2FA codes, or recovery codes, and stores tokens encrypted.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal's security posture is a product decision. It connects to platforms with the narrowest credential each one supports, stores those credentials encrypted at rest, and keeps them revocable from inside the app.",
    ],
    bullets: [
      {
        heading: "Signal never asks for",
        items: ["Your platform password.", "Cookies or browser session tokens.", "2FA or recovery codes.", "Proxy or fingerprint configuration."],
      },
      {
        heading: "How accounts connect",
        items: [
          "X, Reddit, LinkedIn — official OAuth, scopes requested explicitly.",
          "Bluesky — an app password (not your main password).",
          "dev.to, Hashnode — a personal API key/token.",
          "Tokens are encrypted at rest and revocable from Accounts.",
        ],
      },
    ],
    related: ["approval-model", "data-handling", "mcp-security-model"],
    published: true,
  },
  {
    slug: "approval-model",
    section: "trust",
    title: "The approval model",
    description:
      "Human approval is structural in Signal. No path — UI, scheduler, or MCP — publishes without a person approving first.",
    lastUpdated: "2026-06-14",
    overview: [
      "Approval isn't a setting you can turn off; it's the shape of the system. Every item is a recommendation until a person approves it. The scheduler only ever publishes items that were approved, and the MCP bridge funnels work into the very same queue.",
      "Manual retries don't bypass this either: a retry returns a failed item to the state it held at approval, so the original approval still governs it.",
    ],
    bullets: [
      {
        heading: "Where the gate holds",
        items: [
          "UI — you approve in the weekly review.",
          "Scheduler — only publishes approved items.",
          "MCP — assistant-prepared work waits for the same approval.",
          "Retries — return to the approved state, never around it.",
        ],
      },
    ],
    related: ["how-approval-works", "how-signal-prevents-accidental-publishing", "mcp-approval-workflow"],
    published: true,
  },
  {
    slug: "publishing-reliability-trust",
    section: "trust",
    title: "Publishing reliability",
    description:
      "Why you can trust Signal to publish once and only once: atomic claims, bounded retries, and visible stale-claim recovery.",
    lastUpdated: "2026-06-14",
    overview: [
      "Reliability is a trust property, not just an engineering one. Signal is built so a flaky network or a dying process can't turn into a double-post or a silently dropped post.",
      "An atomic claim guarantees only one scheduler tick can publish a given item. Transient errors retry with backoff. If a publish is interrupted after the claim, the item is surfaced as a stale claim for deliberate, manual recovery instead of being blindly re-sent.",
    ],
    related: ["publishing-reliability", "how-signal-handles-failures", "understanding-stale-claims"],
    published: true,
  },
  {
    slug: "data-handling",
    section: "trust",
    title: "Data handling",
    description:
      "What Signal stores, how it's scoped to your workspace, and how platform tokens are protected.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal stores your workspace's content, plan, publish history, verified metrics, and the encrypted credentials needed to publish. Data is scoped per workspace, and access is enforced at the database layer so one workspace can't read another's rows.",
      "Platform tokens are stored encrypted at rest and used only to publish and to read verified metrics. They're revocable from Accounts; revoking disconnects the platform.",
    ],
    bullets: [
      {
        heading: "What's stored",
        items: [
          "Your content, weekly plans, and approval/audit records.",
          "Publish history (the durable record of what went out).",
          "Verified metric snapshots from official provider sources.",
          "Encrypted platform credentials.",
        ],
      },
    ],
    related: ["security-overview", "privacy-overview"],
    published: true,
  },
  {
    slug: "privacy-overview",
    section: "trust",
    title: "Privacy overview",
    description:
      "Signal reads public provider endpoints for metrics, never scrapes, and never sells or fabricates data about your audience.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal's privacy stance follows from its product principles: it works with verified, first-party and public data, and it doesn't manufacture analytics about anyone.",
      "Verified metrics come from official provider APIs or public endpoints for your own posts. Signal does not scrape rendered pages, does not build shadow profiles of your audience, and does not invent engagement, reach, or demographic data.",
    ],
    related: ["data-handling", "why-metrics-unavailable"],
    published: true,
  },
  {
    slug: "how-signal-prevents-accidental-publishing",
    section: "trust",
    title: "How Signal prevents accidental publishing",
    description:
      "The specific mechanisms that stop a post from going out by accident: the approval gate, atomic claims, and manual stale-claim recovery.",
    lastUpdated: "2026-06-14",
    overview: [
      "Accidental publishing has a few distinct causes, and Signal addresses each one directly rather than hoping it won't happen.",
    ],
    bullets: [
      {
        heading: "The safeguards",
        items: [
          "Nothing publishes without approval — an unapproved item physically can't schedule.",
          "An item is claimed before publish, so two scheduler runs can't both send it.",
          "An interrupted publish becomes a stale claim that waits for a human, instead of auto-retrying (which could double-post).",
          "Manual retries return to the approved state — they don't invent a new approval.",
        ],
      },
    ],
    related: ["approval-model", "understanding-stale-claims", "publishing-reliability-trust"],
    published: true,
  },
  {
    slug: "how-signal-handles-failures",
    section: "trust",
    title: "How Signal handles failures",
    description:
      "Failures are surfaced, never hidden: transient errors retry with backoff, permanent ones are marked failed with a reason, and real data is never overwritten.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal treats failure as a first-class state. A transient error retries with backoff; a permanent one is marked failed with a recorded reason and surfaced to you. Nothing fails silently.",
      "The same honesty applies to metrics: if a metrics refresh fails, Signal keeps the last verified numbers and records the error rather than overwriting real data with blanks.",
    ],
    related: ["understanding-failed-posts", "retry-and-backoff", "metrics-refresh"],
    published: true,
  },
  {
    slug: "ai-search-visibility",
    section: "trust",
    title: "AI search & crawler visibility",
    description:
      "How Signal Academy is structured for AI assistants and search — clear answers, honest scope, llms.txt, and crawler-friendly metadata.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal Academy is written to be useful to both people and AI assistants (ChatGPT, Claude, Perplexity, Gemini). That means clear, self-contained answers, accurate scope, and structured metadata — not keyword stuffing.",
      "Every article carries a canonical URL, Open Graph and Twitter tags, JSON-LD (article, breadcrumb, and FAQ where present), and a last-updated date. The Academy also publishes an llms.txt index of its pages, and the site welcomes reputable AI crawlers.",
    ],
    bullets: [
      {
        heading: "What makes a page AI-legible",
        items: [
          "A direct overview that answers the title's question up front.",
          "Honest scope — what's supported, unavailable, or unsupported is stated plainly.",
          "Structured FAQ and steps that map cleanly to questions.",
          "Machine-readable metadata: canonical, OG/Twitter, JSON-LD, llms.txt.",
        ],
      },
    ],
    related: ["security-overview", "why-metrics-unavailable"],
    externalRefs: [{ label: "llms.txt", href: "/llms.txt" }],
    published: true,
  },
];
