import type { Article } from "../types";

export const gettingStarted: Article[] = [
  {
    slug: "what-is-signal",
    section: "getting-started",
    title: "What is Signal",
    description:
      "Signal is an operator-first growth platform: plan weekly, approve once, and publish to real platforms with a reliability system behind every post.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal is a growth operations platform for founders and small teams. Instead of posting reactively, you plan a week of content, review it in a single approval pass, and let Signal publish each item to the platforms you've connected.",
      "Signal is operator-first: nothing leaves your workspace without a human approving it. There is no autopilot that posts on your behalf, no fabricated analytics, and no scraping. Every published post, every metric, and every status you see reflects something that actually happened.",
    ],
    bullets: [
      {
        heading: "What Signal does",
        items: [
          "Weekly planning — organize a week of posts across platforms in one place.",
          "A single approval gate — review and approve before anything is scheduled.",
          "Reliable publishing — a scheduler with claims, retries, and backoff that avoids double-posting.",
          "Verified results — engagement counts pulled from official provider APIs, never estimated.",
          "Teams, notifications, and an MCP bridge for connecting Signal to Claude.",
        ],
      },
      {
        heading: "What Signal does not do",
        items: [
          "It does not auto-publish without approval.",
          "It does not invent reach, impressions, or engagement scores.",
          "It does not scrape platforms or use anti-detect tooling.",
        ],
      },
    ],
    nextSteps: ["getting-started", "understanding-the-workflow"],
    related: ["security-overview", "approval-model"],
    published: true,
  },
  {
    slug: "getting-started",
    section: "getting-started",
    title: "Getting started with Signal",
    description:
      "The fastest path from a new workspace to your first scheduled post: connect an account, create a weekly plan, approve, and let the scheduler publish.",
    lastUpdated: "2026-06-14",
    overview: [
      "This is the short version of the whole product. Each step links to a deeper guide. If you do these five things in order, you'll have a real post scheduled and a clear picture of how Signal works.",
    ],
    steps: [
      {
        title: "Connect a social account",
        body: "Open Accounts and connect at least one platform. Bluesky, dev.to, and Hashnode connect with an app password or API key; X, Reddit, and LinkedIn connect through OAuth. You only need one to start.",
      },
      {
        title: "Create a weekly plan",
        body: "Open Weekly Plan and add the posts you want to go out this week. A plan is just an organized set of items with a target platform and a scheduled time.",
      },
      {
        title: "Review and approve",
        body: "Approval is the gate. Walk the plan once, approve the items you're happy with, and adjust or set aside the rest. Nothing schedules until it's approved.",
      },
      {
        title: "Let the scheduler publish",
        body: "Approved items move to scheduled. The scheduler claims each item at its time, publishes it, and records the outcome — with retries if a platform hiccups.",
      },
      {
        title: "Check Results",
        body: "Open Results to see what actually went out, with real permalinks and timings. For supported platforms, verified engagement appears once metrics refresh.",
      },
    ],
    commonMistakes: [
      "Skipping the approval pass — items that aren't approved never schedule.",
      "Connecting zero accounts and wondering why nothing publishes.",
      "Expecting metrics for platforms that don't expose them; Signal shows \"Unavailable\" rather than guessing.",
    ],
    prerequisites: ["what-is-signal"],
    nextSteps: ["connect-first-account", "first-weekly-plan", "first-scheduled-post"],
    related: ["understanding-the-workflow"],
    published: true,
  },
  {
    slug: "connect-first-account",
    section: "getting-started",
    title: "Connect your first social account",
    description:
      "Connect a platform so Signal can publish for you. Bluesky/dev.to/Hashnode use an app password or API key; X/Reddit/LinkedIn use OAuth.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal publishes to the accounts you connect from the Accounts page. Each platform connects with the credential model that platform supports. Signal never asks for your platform password, cookies, 2FA codes, or recovery codes.",
    ],
    bullets: [
      {
        heading: "How each platform connects",
        items: [
          "Bluesky — an app password you generate in Bluesky settings (not your main password).",
          "dev.to — a personal API key from dev.to settings.",
          "Hashnode — a personal access token plus the target publication.",
          "X, Reddit, LinkedIn — the platform's official OAuth authorization flow.",
          "Telegram — a workspace bot token, with a per-identity chat target.",
        ],
      },
    ],
    steps: [
      {
        title: "Open Accounts and pick a platform",
        body: "Choose the platform you want to connect first. If you're not sure, Bluesky is the quickest — an app password connects immediately.",
      },
      {
        title: "Provide the credential the platform supports",
        body: "Paste the app password / API key, or complete the OAuth flow. Signal stores tokens encrypted at rest and only uses them to publish and read verified metrics.",
      },
      {
        title: "Verify the identity",
        body: "Signal verifies the connection resolves to the account you expect. If the handle doesn't match, you'll see a mismatch warning rather than a silent wrong-account publish.",
      },
    ],
    commonMistakes: [
      "Using your main Bluesky password instead of an app password.",
      "Connecting a Hashnode token without selecting a publication — articles need a destination publication.",
    ],
    troubleshooting: [
      {
        problem: "The connection shows a handle mismatch.",
        fix: "The credential resolved to a different account than the identity expects. Update the identity handle, or reconnect with the credential for the correct account.",
      },
    ],
    prerequisites: ["getting-started"],
    nextSteps: ["first-weekly-plan"],
    related: ["connect-bluesky", "connect-reddit", "connect-x", "security-overview"],
    published: true,
  },
  {
    slug: "first-weekly-plan",
    section: "getting-started",
    title: "Create your first weekly plan",
    description:
      "A weekly plan is an organized set of posts for the week. Add items, set platform and time, then take them through approval.",
    lastUpdated: "2026-06-14",
    overview: [
      "A weekly plan is where you decide what goes out and when. You add items, each targeting a platform with a scheduled time, and then move them through approval as one calm review.",
    ],
    steps: [
      {
        title: "Open Weekly Plan",
        body: "Each plan covers a week. Start with the current week.",
      },
      {
        title: "Add items",
        body: "Add a post per idea. Set the platform and the time you want it to go out. Drafts can stay unscheduled until they're ready.",
      },
      {
        title: "Move items toward approval",
        body: "When an item is ready, take it to approval. Items waiting on you sit in the queue; approved items become scheduled.",
      },
    ],
    commonMistakes: [
      "Treating the plan as a publish button — items still pass through approval before scheduling.",
      "Scheduling everything at the same minute; stagger times so your cadence stays natural.",
    ],
    prerequisites: ["connect-first-account"],
    nextSteps: ["first-scheduled-post"],
    related: ["what-is-a-weekly-plan", "queue-scheduled-published", "how-approval-works"],
    published: true,
  },
  {
    slug: "understanding-the-workflow",
    section: "getting-started",
    title: "Understanding the Signal workflow",
    description:
      "The end-to-end loop: plan → approve → schedule → publish → measure. Approval is the single gate between an idea and a live post.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal has one operating loop. Understanding it makes every other screen obvious.",
      "You plan items in a weekly plan. You approve them in a single pass. Approved items become scheduled. The scheduler publishes each at its time and records the outcome. Results then shows what actually happened, with verified metrics where the platform exposes them.",
    ],
    bullets: [
      {
        heading: "The five stages",
        items: [
          "Plan — organize the week's items (Weekly Plan).",
          "Approve — the single human gate; nothing schedules without it.",
          "Schedule — approved items wait for their time.",
          "Publish — the scheduler claims, publishes, and records each item.",
          "Measure — Results shows real outcomes and verified metrics.",
        ],
      },
    ],
    prerequisites: ["what-is-signal"],
    nextSteps: ["how-publishing-works"],
    related: ["how-approval-works", "publishing-lifecycle", "understanding-results"],
    published: true,
  },
  {
    slug: "first-scheduled-post",
    section: "getting-started",
    title: "Your first scheduled post",
    description:
      "Approve an item, watch it move to scheduled, and understand what the scheduler does when its time arrives.",
    lastUpdated: "2026-06-14",
    overview: [
      "Once you approve an item, it becomes scheduled for the time you set. You don't need to keep a tab open — the scheduler runs on its own and publishes due items.",
      "When an item's time arrives, the scheduler claims it (so it can't be published twice), sends it to the platform, and records the result in publish history. If the platform returns a transient error, Signal retries with backoff instead of failing immediately.",
    ],
    steps: [
      {
        title: "Approve an item",
        body: "From the weekly plan, approve a ready item. It moves out of the queue into scheduled.",
      },
      {
        title: "Wait for its time",
        body: "The scheduler picks up due items automatically. Nothing publishes before its scheduled time.",
      },
      {
        title: "Confirm in Results",
        body: "After it publishes, Results shows the post with its real permalink, the time it went out, and whether it was an automatic or manual publish.",
      },
    ],
    commonMistakes: [
      "Assuming a failed publish is lost — failed items are visible and can be retried.",
      "Re-approving an item that's already running; the claim mechanism prevents double-posting.",
    ],
    prerequisites: ["first-weekly-plan"],
    nextSteps: ["publishing-lifecycle", "understanding-results"],
    related: ["understanding-failed-posts", "publishing-reliability"],
    published: true,
  },
];
