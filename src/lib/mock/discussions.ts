import type { PlatformId, ThreadParticipationSignal } from "@/types";

export interface DiscussionSeed {
  id: string;
  platform: PlatformId;
  context: "subreddit_thread" | "x_thread" | "linkedin_post";
  contextLabel: string;
  threadTitle: string;
  threadSummary: string;
  question: string;
  url: string | null;
  topicTags: string[];
  productMatches: string[];
  participation: ThreadParticipationSignal;
  ageHours: number;
}

export const discussionSeeds: DiscussionSeed[] = [
  {
    id: "disc_reddit_001",
    platform: "reddit",
    context: "subreddit_thread",
    contextLabel: "r/analytics",
    threadTitle: "How are you splitting AI agent traffic from humans?",
    threadSummary:
      "OP is seeing a spike in agent visits and asking how others bucket them in dashboards.",
    question: "Anyone built a clean split for agent vs human traffic?",
    url: null,
    topicTags: ["agent", "analytics", "traffic", "discoverability"],
    productMatches: ["prod_webmasterid"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "low" },
    ageHours: 6,
  },
  {
    id: "disc_reddit_002",
    platform: "reddit",
    context: "subreddit_thread",
    contextLabel: "r/freelance",
    threadTitle: "Why am I always broke even after a good month?",
    threadSummary:
      "Solo freelancer realizing revenue and available cash are not the same thing.",
    question:
      "How do you actually track 'real' cash flow without spreadsheet hell?",
    url: null,
    topicTags: ["cash", "freelance", "tax", "runway"],
    productMatches: ["prod_cash_workspace"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "medium" },
    ageHours: 14,
  },
  {
    id: "disc_reddit_003",
    platform: "reddit",
    context: "subreddit_thread",
    contextLabel: "r/webdev",
    threadTitle: "Best in-browser OCR libraries in 2026?",
    threadSummary:
      "Devs comparing in-browser OCR libraries with claimed perf numbers.",
    question: "Anyone running OCR fully in the browser at scale?",
    url: null,
    topicTags: ["ocr", "browser", "pdf", "performance"],
    productMatches: ["prod_pdf_tools"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "low" },
    ageHours: 9,
  },
  {
    id: "disc_reddit_004",
    platform: "reddit",
    context: "subreddit_thread",
    contextLabel: "r/SaaS",
    threadTitle: "Show your stack — what's actually paying off?",
    threadSummary:
      "Generic 'show your stack' thread, very noisy, hundreds of one-line replies.",
    question: "What part of your stack is actually moving the needle?",
    url: null,
    topicTags: ["saas", "stack", "tools"],
    productMatches: ["prod_helperg"],
    participation: { freshness: "active", audienceMatch: "adjacent", noise: "high" },
    ageHours: 4,
  },
  {
    id: "disc_x_001",
    platform: "x",
    context: "x_thread",
    contextLabel: "@analyticsnoted",
    threadTitle: "Bots are not bots are not bots",
    threadSummary:
      "Founder thread arguing for a richer bot taxonomy in analytics tooling.",
    question:
      "If you're tracking agent traffic, are you breaking it out by intent?",
    url: null,
    topicTags: ["agent", "analytics", "intent"],
    productMatches: ["prod_webmasterid"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "medium" },
    ageHours: 3,
  },
  {
    id: "disc_x_002",
    platform: "x",
    context: "x_thread",
    contextLabel: "@founderdesk",
    threadTitle: "What broke when you stopped posting daily",
    threadSummary:
      "Founder reflecting on the impact of moving to a slower posting cadence.",
    question:
      "Genuinely curious — did anyone post less and grow faster?",
    url: null,
    topicTags: ["cadence", "founder", "posting", "approval"],
    productMatches: ["prod_helperg"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "low" },
    ageHours: 2,
  },
  {
    id: "disc_x_003",
    platform: "x",
    context: "x_thread",
    contextLabel: "@side_hustle",
    threadTitle: "10x your followers with this one trick",
    threadSummary:
      "Engagement-bait thread. Hundreds of low-context replies.",
    question: "What's your one trick?",
    url: null,
    topicTags: ["growth", "viral"],
    productMatches: [],
    participation: { freshness: "active", audienceMatch: "off", noise: "high" },
    ageHours: 8,
  },
  {
    id: "disc_linkedin_001",
    platform: "linkedin",
    context: "linkedin_post",
    contextLabel: "Industry analyst, B2B SaaS",
    threadTitle: "Trust is the new acquisition channel",
    threadSummary:
      "Long-form essay from a B2B analyst on founder credibility and trust.",
    question:
      "What signals build founder credibility before a buyer ever talks to sales?",
    url: null,
    topicTags: ["b2b", "founder", "trust", "credibility"],
    productMatches: ["prod_helperg", "prod_webmasterid"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "medium" },
    ageHours: 18,
  },
  {
    id: "disc_linkedin_002",
    platform: "linkedin",
    context: "linkedin_post",
    contextLabel: "Founder, mid-market SaaS",
    threadTitle: "I stopped publishing weekly — here's what happened",
    threadSummary:
      "Personal essay about reducing posting cadence and seeing engagement quality rise.",
    question: "Has anyone else slowed down on purpose?",
    url: null,
    topicTags: ["cadence", "approval", "posting", "founder"],
    productMatches: ["prod_helperg"],
    participation: { freshness: "settling", audienceMatch: "aligned", noise: "low" },
    ageHours: 30,
  },
  {
    id: "disc_linkedin_003",
    platform: "linkedin",
    context: "linkedin_post",
    contextLabel: "Marketing leader, enterprise",
    threadTitle: "Five marketing trends to watch in 2026",
    threadSummary:
      "Generic trends post, off-shape for our audience and full of corporate clichés.",
    question: "What trend are you watching?",
    url: null,
    topicTags: ["trends", "marketing"],
    productMatches: [],
    participation: { freshness: "settling", audienceMatch: "off", noise: "high" },
    ageHours: 22,
  },
];
