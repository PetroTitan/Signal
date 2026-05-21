import type {
  AccountRole,
  ChecklistItem,
  PlatformId,
  ProductProfile,
  SetupKit,
  WarmUpDay,
} from "@/types";

interface BuildKitInput {
  platform: PlatformId;
  product: ProductProfile;
  role: AccountRole;
  existingHandle?: string | null;
  generatedAt?: string;
}

export function buildSetupKit(input: BuildKitInput): SetupKit {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const { platform, product, role } = input;

  return {
    usernameIdeas: usernameIdeas(platform, product, role),
    displayNameSuggestions: displayNameSuggestions(platform, product, role),
    bioSuggestions: bioSuggestions(platform, product, role),
    aboutText: aboutText(platform, product, role),
    avatarBrief: avatarBrief(platform, product, role),
    coverBrief: coverBrief(platform, product, role),
    contentIdeas: contentIdeas(platform, product, role),
    commentIdeas: commentIdeas(platform, product, role),
    warmUpDays: warmUpDays(platform, role),
    toneReminders: toneReminders(platform, role),
    cadenceNote: cadenceNote(platform),
    pinnedPostIdea: platform === "x" ? pinnedPostIdea(product, role) : null,
    featuredLinkSuggestion:
      platform === "linkedin" ? featuredLinkSuggestion(product) : null,
    subredditDiscovery:
      platform === "reddit" ? subredditDiscovery(product) : [],
    checklist: defaultChecklist(platform),
    generatedAt,
  };
}

// --- usernames / display names ---

function usernameIdeas(
  platform: PlatformId,
  product: ProductProfile,
  role: AccountRole,
): string[] {
  const base = product.slug.replace(/-/g, "_");
  const short = product.slug.replace(/-/g, "").slice(0, 12);
  if (role === "founder") {
    return [
      "petro_helperg",
      "petro_builds",
      "ptr_" + short,
    ];
  }
  if (platform === "reddit") {
    return [
      `u_${base}`.replace(/^u_/, ""),
      `${short}_observer`,
      `${short}_help`,
    ];
  }
  if (platform === "x") {
    return [`${short}`, `${short}_app`, `${short}_io`];
  }
  return [`${base}-${role}`, `${product.slug}`, `${short}-team`];
}

function displayNameSuggestions(
  platform: PlatformId,
  product: ProductProfile,
  role: AccountRole,
): string[] {
  if (role === "founder") {
    return ["Petro", "Petro · HELPERG", "Petro (HELPERG)"];
  }
  if (platform === "reddit") {
    return [
      `${product.name} observer`,
      `${product.name} community`,
      `${product.name} notes`,
    ];
  }
  if (platform === "linkedin") {
    return [
      `${product.name}`,
      `${product.name} — by HELPERG`,
      `${product.name} (HELPERG)`,
    ];
  }
  return [
    `${product.name}`,
    `${product.name} · ${capitalize(role)}`,
    `${product.name} support`,
  ];
}

// --- bios / about ---

function bioSuggestions(
  platform: PlatformId,
  product: ProductProfile,
  role: AccountRole,
): string[] {
  const positioning = shorten(product.positioning, 110);
  if (platform === "linkedin") {
    return [
      `${roleTitle(role)} at ${product.name}. ${positioning}`,
      `${product.name} — ${positioning}`,
      `Working on ${product.name}. Operator notes only.`,
    ];
  }
  if (platform === "x") {
    return [
      `${product.name}: ${positioning}`,
      `Building ${product.name}. ${shorten(product.contentStyle, 80)}`,
      `${product.name}. Built by HELPERG.`,
    ];
  }
  return [
    `I help with ${product.name.toLowerCase()}. Sharing what I learn.`,
    `${product.name} — operator notes. No selling.`,
    `Working on ${product.name}. Happy to answer questions.`,
  ];
}

function aboutText(
  platform: PlatformId,
  product: ProductProfile,
  role: AccountRole,
): string {
  if (platform === "linkedin") {
    return [
      `I work on ${product.name}, a ${product.category} product built for ${product.targetAudience[0] ?? "founders"}.`,
      `Approach: ${product.contentStyle}`,
      `Reach out if you're working on adjacent problems — happy to compare notes.`,
    ].join("\n\n");
  }
  if (platform === "reddit") {
    return [
      `I work on ${product.name}.`,
      `I'll mostly be answering questions and sharing notes. I avoid linking to my own product unless it's directly relevant.`,
    ].join(" ");
  }
  return `${product.name} — ${shorten(product.positioning, 140)}. Reach out if useful. (${roleTitle(role)})`;
}

// --- visuals ---

function avatarBrief(
  platform: PlatformId,
  product: ProductProfile,
  role: AccountRole,
): string {
  if (role === "founder") {
    return "Neutral portrait, daylight, soft background. Same image across all founder accounts.";
  }
  if (platform === "linkedin") {
    return `${product.name} wordmark on calm neutral background. Subtle accent color.`;
  }
  if (platform === "x") {
    return `${product.name} mark on dark slate background. Single accent color.`;
  }
  return `Abstract glyph that hints at the ${product.category} category. No product logo for warm-up phase.`;
}

function coverBrief(
  platform: PlatformId,
  product: ProductProfile,
  _role: AccountRole,
): string {
  if (platform === "reddit") {
    return "Reddit does not use a cover image.";
  }
  if (platform === "linkedin") {
    return `Calm banner: '${product.name} — ${shorten(product.positioning, 60)}'. No screenshots.`;
  }
  return `Annotated product screenshot or single supporting graphic. Calm palette.`;
}

// --- content ideas (10) ---

function contentIdeas(
  platform: PlatformId,
  product: ProductProfile,
  role: AccountRole,
): string[] {
  const ideas = baseContentIdeas(product, role);
  if (platform === "linkedin") {
    ideas.push(
      `Long-form essay: lessons from a quarter of ${product.name} usage.`,
      `Team note: what we got wrong about ${product.category}.`,
    );
  } else if (platform === "x") {
    ideas.push(
      `Short thread: anatomy of one ${product.category} workflow we use daily.`,
      `Reply-worthy observation: a counter-intuitive default in ${product.category}.`,
    );
  } else {
    ideas.push(
      `Discussion post in r/SaaS or adjacent subreddit, no link.`,
      `Helpful guide post answering a common ${product.category} question.`,
    );
  }
  return ideas.slice(0, 10);
}

function baseContentIdeas(product: ProductProfile, role: AccountRole): string[] {
  const audience = product.targetAudience[0] ?? "operators";
  return [
    `Behind-the-scenes note: how ${product.name} stays small.`,
    `Pattern we noticed in ${product.category} this month.`,
    `Question to the audience: how do you currently handle ${product.category}?`,
    `Short walkthrough of a feature ${audience} use most.`,
    `One thing ${product.name} deliberately does not do.`,
    `What we measured this week (no chart inflation).`,
    `Lessons from a ${roleTitle(role)} perspective: what changed our mind.`,
    `Story: the smallest problem ${product.name} ever solved that mattered.`,
  ];
}

// --- comment ideas (10) ---

function commentIdeas(
  platform: PlatformId,
  product: ProductProfile,
  _role: AccountRole,
): string[] {
  if (platform === "reddit") {
    return [
      `Reply to a 'tools for X' thread with the trade-offs you actually live with, no link.`,
      `Answer a beginner's question with concrete steps, no product mention.`,
      `Share a one-paragraph postmortem from your own use of ${product.category}.`,
      `Compare two open approaches the OP didn't consider, neutrally.`,
      `Ask a clarifying question on a thread you'd otherwise skim past.`,
      `Offer a config snippet or small example that resolves the OP's issue.`,
      `Recommend a non-${product.name} resource when it's a better fit.`,
      `Provide a calibration: 'we tried both, here is how they differ in practice'.`,
      `Push back gently when a thread frames a problem too narrowly.`,
      `Acknowledge a critique of ${product.category} tooling and add nuance.`,
    ];
  }
  if (platform === "x") {
    return [
      `One-line reply to a founder thread: agreement plus one concrete data point.`,
      `Reply with a counter-example that holds the OP's point intact.`,
      `Translate a customer story you've seen into one sentence.`,
      `Ask a precise question instead of broadcasting an answer.`,
      `Reply to a 'what do you wish existed' thread with a calm observation.`,
      `Thank someone publicly for a piece of feedback you used.`,
      `Reply with a short before/after metric, no product link.`,
      `Reply to a complaint about ${product.category} with your honest take.`,
      `Surface a missing nuance in a viral take, briefly.`,
      `Reply to a junior operator asking for advice, plainly.`,
    ];
  }
  return [
    `Add one paragraph of operator depth to an industry post.`,
    `Comment on a hiring post with a specific lesson from working in this space.`,
    `Reply to an analyst post with one concrete number from your own work.`,
    `Comment on a competitor's product launch generously and accurately.`,
    `Reply to a customer's post with a useful, link-free recommendation.`,
    `Thank a peer for a public note that influenced your thinking.`,
    `Comment on a long-form piece with a small disagreement and a why.`,
    `Reply to a job-search post with practical resources.`,
    `Add a calibration story to a 'state of the industry' post.`,
    `Reply to a leader you respect with a question, not a hot take.`,
  ];
}

// --- warm-up plan (14 days) ---

function warmUpDays(
  platform: PlatformId,
  _role: AccountRole,
): WarmUpDay[] {
  if (platform === "reddit") {
    return [
      { day: 1, focus: "observation", description: "Subscribe to 6–10 subreddits. Browse. No comments yet." },
      { day: 2, focus: "observation", description: "Read the top posts of each subreddit's last week. Notice the tone." },
      { day: 3, focus: "comments", description: "Leave 3 short helpful comments, no links, no product mentions." },
      { day: 4, focus: "comments", description: "Leave 3 more comments. Engage on threads asking specific questions." },
      { day: 5, focus: "comments", description: "Comment 5 times across the day. Build a reading rhythm, not a reply spree." },
      { day: 6, focus: "replies", description: "Reply to people who reply to you. Stay calm if karma stalls." },
      { day: 7, focus: "observation", description: "Quiet day. Pure reading. Note which subreddits you actually fit." },
      { day: 8, focus: "comments", description: "Comments only. Avoid linking to anything you own." },
      { day: 9, focus: "comments", description: "Comment in 2–3 subreddits you've earned a presence in." },
      { day: 10, focus: "first_post", description: "First helpful, link-free post (question or open observation)." },
      { day: 11, focus: "replies", description: "Answer every reply on yesterday's post." },
      { day: 12, focus: "observation", description: "Quiet day. Look for product-relevant questions you can answer next week." },
      { day: 13, focus: "first_post", description: "Second discussion post. Topic chosen from observations on day 12." },
      { day: 14, focus: "replies", description: "Wrap up replies. Account is now warm enough for weekly planning." },
    ];
  }
  if (platform === "linkedin") {
    return [
      { day: 1, focus: "observation", description: "Curate your feed. Mute generic motivation; follow operators." },
      { day: 2, focus: "comments", description: "Comment thoughtfully on 3 posts from your network." },
      { day: 3, focus: "comments", description: "Comment on 3 more posts. Avoid promotion in the comments." },
      { day: 4, focus: "replies", description: "Reply to every comment on yours so far." },
      { day: 5, focus: "first_post", description: "First short post: an observation, no link, no CTA." },
      { day: 6, focus: "replies", description: "Reply to every comment on yesterday's post." },
      { day: 7, focus: "observation", description: "Quiet day. Read longform pieces; collect angles." },
      { day: 8, focus: "comments", description: "Comment again on 3 industry posts." },
      { day: 9, focus: "first_post", description: "Second short post: a lesson, not a launch." },
      { day: 10, focus: "replies", description: "Reply to commenters. Build relationships over reach." },
      { day: 11, focus: "long_form", description: "Draft a long-form essay. Do not publish yet." },
      { day: 12, focus: "observation", description: "Quiet day. Edit the essay." },
      { day: 13, focus: "long_form", description: "Publish the long-form essay (no link to product)." },
      { day: 14, focus: "replies", description: "Reply throughout the day. Account is ready for planning." },
    ];
  }
  return [
    { day: 1, focus: "observation", description: "Read your timeline. Don't post yet. Note voices you'd reply to." },
    { day: 2, focus: "replies", description: "Reply to 3 founder threads. One sentence each, on substance." },
    { day: 3, focus: "replies", description: "Reply to 5 threads today. Stay on substance, not snark." },
    { day: 4, focus: "first_post", description: "First short post: a one-line observation. No link." },
    { day: 5, focus: "replies", description: "Reply to comments on yesterday's post. Follow up by DMing nobody." },
    { day: 6, focus: "observation", description: "Quiet day. Read. Don't post." },
    { day: 7, focus: "replies", description: "5 thoughtful replies." },
    { day: 8, focus: "first_post", description: "Second short post — an observation, not a launch." },
    { day: 9, focus: "thread", description: "First thread: structure as 4–6 short posts, end on a question." },
    { day: 10, focus: "replies", description: "Spend the day in the replies under the thread." },
    { day: 11, focus: "observation", description: "Quiet day. Drafts only." },
    { day: 12, focus: "first_post", description: "Short post calibrated to what worked." },
    { day: 13, focus: "thread", description: "Second thread, this time grounded in a concrete number." },
    { day: 14, focus: "replies", description: "Reply through the day. Account is ready for the weekly plan." },
  ];
}

// --- tone / cadence ---

function toneReminders(platform: PlatformId, role: AccountRole): string[] {
  const universal = [
    "Lead with substance, not personality.",
    "Avoid superlatives ('best', 'guaranteed', 'magic').",
    "Be specific. Numbers, screenshots, examples.",
  ];
  if (platform === "reddit") {
    return [
      ...universal,
      "Comment-first. Posts only after you've built a reading rhythm.",
      "Never link to your own product in your first month.",
      "Match each subreddit's voice — formal in r/cscareerquestions, casual in r/SaaS.",
    ];
  }
  if (platform === "linkedin") {
    return [
      ...universal,
      "Founder voice outperforms company voice. Speak as yourself.",
      "Long-form essays beat link drops. Lead with a story.",
      role === "founder" ? "Public hiring signals are welcome, but always concrete." : "Stay technical and operational; avoid corporate phrasing.",
    ];
  }
  return [
    ...universal,
    "Replies are first-class presence. They count even if no one likes them.",
    "Pinned post should be a calm thread, not a sales pitch.",
    "Threads under 6 posts. Long isn't depth; precision is.",
  ];
}

function cadenceNote(platform: PlatformId): string {
  if (platform === "reddit") {
    return "Reddit cadence: at most 4 posts/week. Comments are unlimited, but quality first. Suggested: 2 posts/week once warm.";
  }
  if (platform === "linkedin") {
    return "LinkedIn cadence: 3 posts/week suggested, 5 maximum. 24h between posts. Comments daily.";
  }
  return "X cadence: 7 posts/week suggested, 14 maximum. Minimum 6h between posts. Replies are unlimited.";
}

// --- pinned / featured ---

function pinnedPostIdea(product: ProductProfile, _role: AccountRole): string {
  return `Pin a 4-post thread introducing ${product.name}: the problem, the approach, what it isn't, and how to try it. No link until post 4.`;
}

function featuredLinkSuggestion(product: ProductProfile): string {
  return `Featured: a single founder essay on ${product.category}. Avoid a product page until LinkedIn trust is built.`;
}

function subredditDiscovery(product: ProductProfile): string[] {
  const generic = ["r/SaaS", "r/Entrepreneur", "r/Startups", "r/smallbusiness"];
  const category: Record<string, string[]> = {
    analytics: ["r/analytics", "r/webdev", "r/dataisbeautiful"],
    finance: ["r/personalfinance", "r/freelance", "r/Accounting"],
    communication: ["r/iphone", "r/Android", "r/sysadmin"],
    productivity: ["r/productivity", "r/notion", "r/Workflow"],
    utility: ["r/software", "r/excel", "r/sysadmin"],
    consulting: ["r/consulting", "r/freelance"],
  };
  return [...(category[product.category] ?? []), ...generic].slice(0, 6);
}

// --- checklist ---

function defaultChecklist(platform: PlatformId): ChecklistItem[] {
  const oauthLabel =
    platform === "reddit"
      ? "Reddit OAuth connection (placeholder — not yet enabled)"
      : platform === "linkedin"
        ? "LinkedIn OAuth connection (placeholder — not yet enabled)"
        : "X OAuth connection (placeholder — not yet enabled)";
  return [
    { id: "kit_generated", label: "Profile kit generated", done: true, category: "kit" },
    { id: "manual_account_created", label: "Account created manually on the platform", done: false, category: "manual" },
    { id: "email_verified", label: "Email verified", done: false, category: "manual" },
    { id: "2fa_enabled", label: "Two-factor authentication enabled", done: false, category: "security" },
    { id: "profile_completed", label: "Display name, bio, and avatar set", done: false, category: "profile" },
    { id: "first_warmup_planned", label: "First warm-up actions planned", done: false, category: "planning" },
    { id: "oauth_connected", label: oauthLabel, done: false, category: "oauth" },
    { id: "ready_for_planning", label: "Marked ready for weekly planning", done: false, category: "planning" },
  ];
}

// --- helpers ---

function roleTitle(role: AccountRole): string {
  return capitalize(role);
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function shorten(s: string, n: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= n) return trimmed;
  return trimmed.slice(0, n - 1).trimEnd() + "…";
}
