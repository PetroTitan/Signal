import type { Article } from "../types";

export const results: Article[] = [
  {
    slug: "understanding-results",
    section: "results",
    title: "Understanding Results",
    description:
      "Results shows what actually went out — real permalinks, timings, and outcomes — plus verified engagement where the platform exposes it.",
    lastUpdated: "2026-06-14",
    overview: [
      "Results is the record of what actually published. It's read from publish history, so every row is a real post with a real permalink and a real time. Nothing here is projected or simulated.",
      "For platforms that expose metrics, Results also shows verified engagement once metrics have been fetched. For platforms that don't, it shows an honest status instead of a number.",
    ],
    bullets: [
      {
        heading: "Each result shows",
        items: [
          "The post's title and platform.",
          "Its real permalink (open it to see the live post).",
          "When it published and whether it was automatic or manual.",
          "Its metrics status: connected, pending, unavailable, or unsupported.",
        ],
      },
    ],
    nextSteps: ["metrics-refresh", "results-intelligence"],
    related: ["supported-metrics-by-platform", "why-metrics-unavailable"],
    published: true,
  },
  {
    slug: "metrics-refresh",
    section: "results",
    title: "Metrics refresh explained",
    description:
      "Signal refreshes verified metrics on a schedule and on demand, with a cooldown per post, and never overwrites real data with empties.",
    lastUpdated: "2026-06-14",
    overview: [
      "Metrics aren't live-polled on every page load — they're cached and refreshed. A daily sweep re-fetches metrics for posts that are due, and you can refresh a single post on demand from Results.",
      "Each connected post has a cooldown before it's re-fetched, so refreshing respects platform rate limits. Crucially, if a refresh fails (a timeout, a platform hiccup), Signal keeps the last verified numbers and records the error — it never overwrites real data with blanks.",
    ],
    bullets: [
      {
        heading: "How refresh behaves",
        items: [
          "Scheduled — a daily sweep refreshes due posts and seeds first fetches for new ones.",
          "On demand — refresh a single post from Results.",
          "Cooldown — a post isn't re-fetched until its cooldown passes.",
          "No clobber — a failed refresh preserves the last verified values.",
          "History — each successful fetch is kept as a snapshot over time.",
        ],
      },
    ],
    prerequisites: ["understanding-results"],
    nextSteps: ["supported-metrics-by-platform", "results-intelligence"],
    related: ["why-metrics-unavailable"],
    published: true,
  },
  {
    slug: "supported-metrics-by-platform",
    section: "results",
    title: "Supported metrics by platform",
    description:
      "Exactly which verified metrics Signal reads per platform, and which platforms are unavailable or unsupported.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal only shows metrics it can read from an official provider source. Here's the current matrix of what's verified, what's unavailable on the current integration, and what isn't read at all.",
    ],
    bullets: [
      {
        heading: "Verified (real counts shown)",
        items: [
          "Bluesky — likes, reposts, replies, quotes (public app-view).",
          "Reddit — score, comments (official public JSON).",
          "dev.to — public reactions, comments (public article API).",
        ],
      },
      {
        heading: "Unavailable (real API exists, not reachable here)",
        items: [
          "X — requires an elevated/paid API tier.",
          "Hashnode — requires a GraphQL analytics query not yet integrated.",
          "LinkedIn — requires approved Marketing API access.",
        ],
      },
      {
        heading: "Unsupported (no post-metrics read)",
        items: ["Telegram", "Threads", "Instagram", "YouTube"],
      },
    ],
    prerequisites: ["understanding-results"],
    related: ["why-metrics-unavailable", "bluesky-metrics", "reddit-metrics", "devto-metrics"],
    published: true,
  },
  {
    slug: "why-metrics-unavailable",
    section: "results",
    title: "Why some metrics are unavailable",
    description:
      "\"Unavailable\" and \"Unsupported\" are honest states, not errors. Signal shows them instead of estimating engagement it can't verify.",
    lastUpdated: "2026-06-14",
    overview: [
      "When you see Unavailable or Unsupported on a post, that's Signal being honest about what it can verify — not a bug.",
      "Unavailable means the platform has a metrics API, but the current integration or tier can't reach it (for example, X requires a paid tier). Unsupported means Signal doesn't read post metrics for that platform at all. In neither case will Signal invent a number.",
    ],
    bullets: [
      {
        heading: "The states",
        items: [
          "Connected — verified counts are shown.",
          "Pending — a verified platform whose first fetch hasn't run yet.",
          "Unavailable — a real metric exists but isn't reachable on this integration/tier.",
          "Unsupported — Signal does not read metrics for this platform.",
        ],
      },
    ],
    prerequisites: ["understanding-results"],
    related: ["supported-metrics-by-platform", "x-metrics-availability", "hashnode-metrics-availability"],
    published: true,
  },
  {
    slug: "best-publishing-time",
    section: "results",
    title: "Best publishing time explained",
    description:
      "Signal derives your best publishing time from actual engagement on real posts — and shows nothing until there's enough verified data.",
    lastUpdated: "2026-06-14",
    overview: [
      "Best publishing time is computed only from verified engagement on posts you've actually published. Signal buckets your connected posts by time (in UTC) and reports the windows with the highest average engagement.",
      "If you don't have enough measured posts yet, Signal returns \"insufficient data\" instead of a misleading recommendation. It would rather say nothing than guess.",
    ],
    bullets: [
      {
        heading: "How it's computed",
        items: [
          "Only posts with verified, connected metrics are used.",
          "Engagement is the sum of real provider counts — never an estimate.",
          "Buckets are by weekday and hour in UTC.",
          "Below a minimum sample size, the result is insufficient_data.",
        ],
      },
    ],
    prerequisites: ["results-intelligence"],
    related: ["metrics-refresh", "supported-metrics-by-platform"],
    published: true,
  },
  {
    slug: "results-intelligence",
    section: "results",
    title: "Results Intelligence explained",
    description:
      "Top posts, top platforms, publishing consistency, and best time — all derived from verified data, with honest thresholds.",
    lastUpdated: "2026-06-14",
    overview: [
      "Results Intelligence turns verified data into a few useful summaries. Every number comes from real publish timestamps and verified provider counts — there are no inferred trends, no AI summaries, and no synthetic engagement.",
      "Each summary has a minimum sample size. Below it, the summary shows \"not enough measured posts yet\" rather than a number that would mislead you.",
    ],
    bullets: [
      {
        heading: "What it computes",
        items: [
          "Top posts — ranked by verified engagement (sum of real counts).",
          "Top platforms — average verified engagement per measured post.",
          "Publishing consistency — from real publish timestamps (posts/week, active days, longest gap).",
          "Best publishing time — highest-engagement windows in UTC.",
        ],
      },
    ],
    prerequisites: ["understanding-results"],
    nextSteps: ["best-publishing-time"],
    related: ["metrics-refresh", "supported-metrics-by-platform"],
    published: true,
  },
];
