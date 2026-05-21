import type {
  PlatformCadencePolicy,
  PlatformContentFormat,
  PlatformId,
  PlatformPlaybook,
  PlatformRiskRule,
  PlatformStrategy,
} from "@/types";

const strategies: Record<PlatformId, PlatformStrategy> = {
  reddit: {
    platform: "reddit",
    strategicRole: "Community presence and discussion depth.",
    primaryGrowthObjective:
      "Earn trust inside subreddits relevant to each product. Comments first, posts later, links last.",
    toneVoice: "Calm, community-native, non-promotional.",
    shortDescription:
      "Reddit is where Signal accounts build credibility through helpful comments and patient discussion.",
    longDescription:
      "Reddit is the platform where promotional posts age the worst. The goal is to be useful inside specific subreddits before referencing a product. Signal's Reddit cadence is slower than the other platforms, link tolerance is lower, and warm-up is longer.",
    approvalBehavior:
      "Discussion posts require a warmed account and a real reason to post. Direct-link items default to a high risk flag.",
    schedulingBehavior:
      "Reddit items are placed on weekdays inside a 14:00–22:00 UTC window. Posts are spaced at least 36 hours per account.",
    analyticsExpectations:
      "Per-subreddit attribution. Tracking happens only when WebmasterID is connected.",
  },
  x: {
    platform: "x",
    strategicRole: "Founder voice, distribution, and network.",
    primaryGrowthObjective:
      "Build a recognizable founder voice and a reliable reply rhythm. Threads are reserved for ideas worth holding attention.",
    toneVoice: "Sharp, concise, founder-native — not hypey.",
    shortDescription:
      "X is the fastest surface and the easiest to overuse. Signal's X strategy is built around restraint and replies.",
    longDescription:
      "X rewards consistency more than volume. The plan favors replies and short observations over launches and link drops. Threads are deliberate and structured. Pinned content is reserved for a single calibrated thread per product.",
    approvalBehavior:
      "Replies and short posts approve quickly. Threads and direct-link posts go through softer-tone and link-saturation checks.",
    schedulingBehavior:
      "X items distribute across the week with at least 6 hours per account between posts. Burst behavior is rejected.",
    analyticsExpectations:
      "Per-account engagement and reply quality once WebmasterID is wired.",
  },
  linkedin: {
    platform: "linkedin",
    strategicRole: "B2B trust and founder credibility.",
    primaryGrowthObjective:
      "Build authority through founder voice, professional storytelling, and long-form essays. Quality over frequency.",
    toneVoice: "Professional, credible, restrained, B2B-grade.",
    shortDescription:
      "LinkedIn rewards depth and polish. Signal's LinkedIn strategy is built around a smaller number of well-shaped posts.",
    longDescription:
      "LinkedIn is the trust layer. Posts have higher polish, longer narrative, and lower tolerance for noisy promotion. Comments on industry posts count as first-class presence. Featured content is reserved for one founder essay, not a product link.",
    approvalBehavior:
      "Long-form items receive an extra polish check. Casual tone and weak credibility are flagged.",
    schedulingBehavior:
      "LinkedIn items are placed Tue–Thu inside 08:00–16:00 UTC with at least 24 hours per account between posts.",
    analyticsExpectations:
      "Per-product engagement and inbound conversation once WebmasterID is wired.",
  },
};

const cadencePolicies: Record<PlatformId, PlatformCadencePolicy> = {
  reddit: {
    platform: "reddit",
    minHoursBetweenPosts: 36,
    suggestedPostsPerWeek: 2,
    maxPostsPerWeek: 4,
    cadenceMode: "calm",
    notes: [
      "Subreddit-specific cooldowns: avoid posting twice in the same subreddit within a week.",
      "Comments are unlimited but quality-first.",
      "Direct outbound links are exceptional, not routine.",
    ],
  },
  x: {
    platform: "x",
    minHoursBetweenPosts: 6,
    suggestedPostsPerWeek: 7,
    maxPostsPerWeek: 14,
    cadenceMode: "moderate",
    notes: [
      "Replies are first-class presence and not capped.",
      "Threads should be at least 36 hours apart on the same account.",
      "Avoid synchronized posting between accounts in the same workspace.",
    ],
  },
  linkedin: {
    platform: "linkedin",
    minHoursBetweenPosts: 24,
    suggestedPostsPerWeek: 3,
    maxPostsPerWeek: 5,
    cadenceMode: "calm",
    notes: [
      "Long-form essays count as a single post in cadence terms but warrant a quieter following day.",
      "Comments on industry posts daily are encouraged and not capped.",
      "Avoid promotional posting more than once per week per account.",
    ],
  },
};

const contentFormats: Record<PlatformId, PlatformContentFormat[]> = {
  reddit: [
    {
      id: "helpful_comment",
      label: "Helpful comment",
      description:
        "Reply that adds substance to a thread without promoting. Most of Reddit work is in comments.",
      promotionalLevel: "low",
      recommendedFor: "all",
    },
    {
      id: "discussion_post",
      label: "Discussion post",
      description:
        "Open-ended post inviting community input. No outbound link unless directly relevant.",
      promotionalLevel: "low",
      recommendedFor: ["founder", "product", "research"],
    },
    {
      id: "question_post",
      label: "Question post",
      description:
        "Genuine question to a specific subreddit. Used to learn, not to advertise.",
      promotionalLevel: "low",
      recommendedFor: "all",
    },
    {
      id: "founder_lesson",
      label: "Founder lesson",
      description:
        "First-person post describing a lesson from operating a small product. Light-link only.",
      promotionalLevel: "medium",
      recommendedFor: ["founder"],
    },
    {
      id: "soft_feedback_request",
      label: "Soft feedback request",
      description:
        "Post asking for feedback on a specific decision (not a product launch). Includes a single contextual link when policy allows.",
      promotionalLevel: "medium",
      recommendedFor: ["founder", "product"],
    },
  ],
  x: [
    {
      id: "short_post",
      label: "Short post",
      description: "One- to three-sentence observation. The default X output.",
      promotionalLevel: "low",
      recommendedFor: "all",
    },
    {
      id: "thread",
      label: "Thread",
      description:
        "4–6 short posts. Reserve threads for ideas worth holding attention.",
      promotionalLevel: "medium",
      recommendedFor: ["founder", "product"],
    },
    {
      id: "reply",
      label: "Reply",
      description:
        "Reply to a thread or post in your network. Replies count as native presence.",
      promotionalLevel: "low",
      recommendedFor: "all",
    },
    {
      id: "founder_observation",
      label: "Founder observation",
      description: "A personal, calibrated note from the founder's voice.",
      promotionalLevel: "low",
      recommendedFor: ["founder"],
    },
    {
      id: "build_in_public_update",
      label: "Build-in-public update",
      description:
        "A specific, dated, factual progress update. Numbers preferred over adjectives.",
      promotionalLevel: "medium",
      recommendedFor: ["founder", "product"],
    },
    {
      id: "product_micro_story",
      label: "Product micro-story",
      description:
        "A short customer story or one-paragraph case study. Always concrete.",
      promotionalLevel: "medium",
      recommendedFor: ["product"],
    },
  ],
  linkedin: [
    {
      id: "founder_post",
      label: "Founder post",
      description:
        "Personal essay or short reflection. The strongest format on LinkedIn.",
      promotionalLevel: "low",
      recommendedFor: ["founder"],
    },
    {
      id: "professional_insight",
      label: "Professional insight",
      description:
        "Industry-level take grounded in lived experience. Avoids generic advice.",
      promotionalLevel: "low",
      recommendedFor: ["founder", "product"],
    },
    {
      id: "company_update",
      label: "Company update",
      description:
        "Update on the product or team. Used sparingly to preserve credibility.",
      promotionalLevel: "medium",
      recommendedFor: ["product", "founder"],
    },
    {
      id: "case_study",
      label: "Case study",
      description:
        "Customer or scenario story with concrete numbers and a clean structure.",
      promotionalLevel: "medium",
      recommendedFor: ["product"],
    },
    {
      id: "thoughtful_comment",
      label: "Thoughtful comment",
      description:
        "Reply to an industry post that adds depth. Comments count as presence.",
      promotionalLevel: "low",
      recommendedFor: "all",
    },
    {
      id: "product_lesson",
      label: "Product lesson",
      description:
        "Lesson learned operating the product. Useful for showing thinking, not selling.",
      promotionalLevel: "medium",
      recommendedFor: ["founder", "product"],
    },
  ],
};

const riskRules: Record<PlatformId, PlatformRiskRule[]> = {
  reddit: [
    {
      id: "reddit_link_too_early",
      title: "Direct link too early",
      description:
        "Outbound link posted by an account that has not yet earned community presence.",
      severity: "high",
      mitigation: "Remove the link, post link-free, return to it after more comments.",
    },
    {
      id: "reddit_same_domain_repeated",
      title: "Same domain repeated",
      description:
        "Same outbound domain has appeared from the same account this week.",
      severity: "high",
      mitigation: "Skip this post or move to the backlog.",
    },
    {
      id: "reddit_same_subreddit_repeated",
      title: "Same subreddit repeated",
      description:
        "Two or more posts in the same subreddit within a short window.",
      severity: "medium",
      mitigation: "Stagger across different subreddits.",
    },
    {
      id: "reddit_promotional_wording",
      title: "Promotional wording",
      description:
        "Phrases like 'best', 'guaranteed', or comparative claims trigger Reddit's tone allergy.",
      severity: "medium",
      mitigation: "Rewrite softer.",
    },
    {
      id: "reddit_low_community_fit",
      title: "Low community fit",
      description:
        "Subreddit choice doesn't match the topic or audience defined for the product.",
      severity: "medium",
      mitigation: "Reconsider the subreddit selection.",
    },
    {
      id: "reddit_warming",
      title: "Account not warmed up",
      description:
        "Account is still inside the 14-day warm-up window.",
      severity: "high",
      mitigation: "Hold post; keep contributing comments.",
    },
    {
      id: "reddit_post_comment_ratio",
      title: "Too many posts vs comments",
      description:
        "Account has more posts than comments this week. Reddit penalizes accounts that publish without engaging.",
      severity: "medium",
      mitigation: "Add 5 substantive comments before publishing the next post.",
    },
  ],
  x: [
    {
      id: "x_too_many_links",
      title: "Too many links",
      description:
        "More than one outbound product link per day on the same account.",
      severity: "high",
      mitigation: "Remove or delay the link.",
    },
    {
      id: "x_repetitive_hooks",
      title: "Repetitive hooks",
      description:
        "Hook reuses a phrase from another recent post on this account.",
      severity: "medium",
      mitigation: "Rewrite the hook.",
    },
    {
      id: "x_launchy_wording",
      title: "Overly promotional launch wording",
      description:
        "Words like 'introducing', 'launching', 'mega' over-saturate timeline relevance.",
      severity: "medium",
      mitigation: "Lead with the problem, not the launch.",
    },
    {
      id: "x_post_bursts",
      title: "Posting bursts",
      description: "Two or more posts within 60 minutes from the same account.",
      severity: "high",
      mitigation: "Space posts at least 6 hours apart.",
    },
    {
      id: "x_same_product_repeated",
      title: "Same product repeated",
      description:
        "The same product has been referenced multiple times in a short window.",
      severity: "medium",
      mitigation: "Rotate to other portfolio items or hold for next week.",
    },
    {
      id: "x_reply_spam_pattern",
      title: "Reply spam pattern",
      description:
        "Identical or near-identical replies across multiple threads.",
      severity: "high",
      mitigation: "Write replies one at a time. Treat each reply as the only one.",
    },
  ],
  linkedin: [
    {
      id: "linkedin_weak_credibility",
      title: "Weak credibility",
      description:
        "Post relies on adjectives instead of specifics. Reads as generic.",
      severity: "medium",
      mitigation: "Add a specific number, customer, or concrete example.",
    },
    {
      id: "linkedin_too_casual",
      title: "Too casual tone",
      description:
        "Wording is closer to a personal feed than to a B2B audience.",
      severity: "medium",
      mitigation: "Tighten phrasing; remove emoji-heavy framing.",
    },
    {
      id: "linkedin_too_salesy",
      title: "Too salesy",
      description: "CTA-heavy phrasing or repetitive product mentions.",
      severity: "high",
      mitigation: "Remove CTA, lead with a lesson.",
    },
    {
      id: "linkedin_overposting",
      title: "Overposting",
      description:
        "More than five posts on the same account this week.",
      severity: "high",
      mitigation: "Move the additional item to the backlog.",
    },
    {
      id: "linkedin_unsupported_claims",
      title: "Unsupported claims",
      description:
        "Claim made without an example, data point, or named source.",
      severity: "medium",
      mitigation: "Add a concrete example or remove the claim.",
    },
    {
      id: "linkedin_fake_authority",
      title: "Fake authority",
      description:
        "Generic 'lessons from leadership' framing that hasn't been earned.",
      severity: "high",
      mitigation: "Reframe as a specific story from your own work.",
    },
    {
      id: "linkedin_excessive_promotion",
      title: "Excessive product promotion",
      description:
        "Multiple product-promotion posts in a week from the same account.",
      severity: "high",
      mitigation: "Hold; let the trust layer breathe.",
    },
  ],
};

const playbooks: Record<PlatformId, PlatformPlaybook> = {
  reddit: {
    platform: "reddit",
    modules: [
      {
        id: "subreddit_intelligence",
        title: "Subreddit intelligence",
        description:
          "Per-product subreddit list with category fit. Recompiled from product profiles.",
        status: "active",
      },
      {
        id: "community_fit",
        title: "Community fit",
        description:
          "Match score between the planned item and the chosen subreddit. Surfaces low-fit items for review.",
        status: "active",
      },
      {
        id: "comments_first_queue",
        title: "Comments-first queue",
        description:
          "Comment-type items pulled forward in the weekly plan. Reddit accounts post only after a baseline of comments.",
        status: "active",
      },
      {
        id: "discussion_post_queue",
        title: "Discussion post queue",
        description:
          "Discussion and question posts grouped together for tone review.",
        status: "active",
      },
      {
        id: "no_link_mode",
        title: "No-link mode",
        description:
          "Default for warming accounts. All outbound links are stripped from drafts during this period.",
        status: "passive",
      },
      {
        id: "link_tolerance",
        title: "Link tolerance",
        description:
          "Per-account allowance for outbound links. Increases only after sustained community presence.",
        status: "passive",
      },
      {
        id: "promo_risk",
        title: "Promo risk",
        description:
          "Live count of items flagged for promotional wording or saturation.",
        status: "active",
      },
      {
        id: "cadence_protection",
        title: "Cadence protection",
        description:
          "Reddit-specific cadence load — slower than other platforms by design.",
        status: "active",
      },
      {
        id: "moderator_risk_placeholder",
        title: "Removal / moderator risk",
        description:
          "Future surface for moderator removal patterns once Reddit API is connected.",
        status: "placeholder",
      },
      {
        id: "warm_up_status",
        title: "Account warm-up status",
        description:
          "Where each Reddit account sits in the 14-day warm-up plan.",
        status: "active",
      },
    ],
  },
  x: {
    platform: "x",
    modules: [
      {
        id: "hook_bank",
        title: "Hook bank",
        description:
          "Reusable opening lines tuned to each product's positioning. Hooks rotate so accounts don't repeat themselves.",
        status: "passive",
      },
      {
        id: "thread_queue",
        title: "Thread queue",
        description: "All thread-type items in the weekly plan, grouped together.",
        status: "active",
      },
      {
        id: "short_post_queue",
        title: "Short post queue",
        description: "Short observations and build-in-public updates for the week.",
        status: "active",
      },
      {
        id: "reply_strategy",
        title: "Reply strategy",
        description:
          "Reply items pulled forward. Replies are first-class presence on X.",
        status: "active",
      },
      {
        id: "founder_voice",
        title: "Founder voice",
        description:
          "Per-product tone reminders so the founder account sounds consistent over the week.",
        status: "passive",
      },
      {
        id: "build_in_public_ideas",
        title: "Build-in-public ideas",
        description:
          "Calibrated, dated update ideas. Numbers preferred over adjectives.",
        status: "passive",
      },
      {
        id: "timing_windows",
        title: "Timing windows",
        description:
          "Preferred publishing windows by platform-load and account cooldown.",
        status: "active",
      },
      {
        id: "engagement_follow_up",
        title: "Engagement follow-up",
        description:
          "Reminder to spend the day under threads, not in pre-planned follow-ups.",
        status: "passive",
      },
      {
        id: "pinned_post_placeholder",
        title: "Pinned post",
        description:
          "Reserve one calibrated thread per product as the pinned post once the account is warm.",
        status: "placeholder",
      },
      {
        id: "account_velocity_control",
        title: "Account velocity control",
        description:
          "Per-account weekly count vs. suggested cadence. Slows down hot accounts.",
        status: "active",
      },
    ],
  },
  linkedin: {
    platform: "linkedin",
    modules: [
      {
        id: "authority_posts",
        title: "Authority posts",
        description: "Long-form posts that anchor LinkedIn presence.",
        status: "active",
      },
      {
        id: "founder_narrative",
        title: "Founder narrative",
        description:
          "Continuing story arc across multiple posts. Tracked in passive notes.",
        status: "passive",
      },
      {
        id: "professional_trust_layer",
        title: "Professional trust layer",
        description:
          "Quality checks: specificity, concrete examples, named sources.",
        status: "active",
      },
      {
        id: "company_updates",
        title: "Company updates",
        description: "Sparing per-product updates over the week.",
        status: "active",
      },
      {
        id: "case_study_drafts",
        title: "Case study drafts",
        description: "Case-study items in the plan, grouped for polish review.",
        status: "active",
      },
      {
        id: "comment_strategy",
        title: "Comment strategy",
        description:
          "Reply targets and themes. Comments on industry posts count as presence.",
        status: "passive",
      },
      {
        id: "profile_credibility",
        title: "Profile credibility",
        description:
          "Account-level checks: headline set, about written, founder identity clear.",
        status: "active",
      },
      {
        id: "featured_link_placeholder",
        title: "Featured link",
        description:
          "Reserved for one founder essay per product when LinkedIn API is connected.",
        status: "placeholder",
      },
      {
        id: "b2b_positioning",
        title: "B2B positioning",
        description: "Per-product positioning, surfaced inline with each post.",
        status: "passive",
      },
      {
        id: "polish_requirements",
        title: "Polish requirements",
        description:
          "Pre-publish checklist: structure, specificity, no fake authority, no excess CTA.",
        status: "active",
      },
    ],
  },
};

export function getPlatformStrategy(platform: PlatformId): PlatformStrategy {
  return strategies[platform];
}

export function getPlatformCadencePolicy(
  platform: PlatformId,
): PlatformCadencePolicy {
  return cadencePolicies[platform];
}

export function getPlatformContentFormats(
  platform: PlatformId,
): PlatformContentFormat[] {
  return contentFormats[platform];
}

export function getPlatformRiskRules(platform: PlatformId): PlatformRiskRule[] {
  return riskRules[platform];
}

export function getPlatformPlaybook(platform: PlatformId): PlatformPlaybook {
  return playbooks[platform];
}
