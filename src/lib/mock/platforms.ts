import type { Platform } from "@/types";

export const platforms: Platform[] = [
  {
    id: "reddit",
    name: "Reddit",
    shortName: "Reddit",
    description: "Subreddit-native discussion. Most sensitive to promotional tone.",
    oauthAvailable: true,
    cadenceGuidance: {
      minHoursBetweenPosts: 36,
      maxPostsPerWeek: 4,
      suggestedPostsPerWeek: 2,
    },
    promotionalToneAllowance: "very_low",
    notes: [
      "Comment-first cadence. Top-of-funnel posts only after sustained karma.",
      "Avoid repeated outbound links from the same account.",
    ],
  },
  {
    id: "x",
    name: "X",
    shortName: "X",
    description: "Short-form, fast cadence. Threads and reply-driven distribution.",
    oauthAvailable: true,
    cadenceGuidance: {
      minHoursBetweenPosts: 6,
      maxPostsPerWeek: 14,
      suggestedPostsPerWeek: 7,
    },
    promotionalToneAllowance: "low",
    notes: [
      "Replies count as native presence. Pinned thread per product.",
      "Stagger promotional content across the week.",
    ],
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    shortName: "LinkedIn",
    description: "Professional surface. Long-form posts, founder voice, hiring signals.",
    oauthAvailable: true,
    cadenceGuidance: {
      minHoursBetweenPosts: 24,
      maxPostsPerWeek: 5,
      suggestedPostsPerWeek: 3,
    },
    promotionalToneAllowance: "medium",
    notes: [
      "Comments on industry posts are first-class presence.",
      "Personal posts outperform company-page posts.",
    ],
  },
];

export const platformsById = Object.fromEntries(
  platforms.map((p) => [p.id, p]),
) as Record<Platform["id"], Platform>;
