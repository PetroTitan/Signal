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
    topicTags: ["agent", "analytics", "traffic"],
    productMatches: ["prod_webmasterid"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "low" },
    ageHours: 6,
  },
  {
    id: "disc_x_001",
    platform: "x",
    context: "x_thread",
    contextLabel: "Founder thread",
    threadTitle: "What broke when you stopped posting daily",
    threadSummary:
      "Founder reflecting on the impact of moving to a slower posting cadence.",
    question: "Did anyone post less and grow faster?",
    url: null,
    topicTags: ["cadence", "founder", "approval"],
    productMatches: ["prod_helperg"],
    participation: { freshness: "active", audienceMatch: "aligned", noise: "low" },
    ageHours: 2,
  },
  {
    id: "disc_x_002",
    platform: "x",
    context: "x_thread",
    contextLabel: "Generic growth post",
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
];
