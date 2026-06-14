import type { Article } from "../types";

export const weeklyPlans: Article[] = [
  {
    slug: "what-is-a-weekly-plan",
    section: "weekly-plans",
    title: "What is a weekly plan",
    description:
      "A weekly plan is an organized set of posts for one week. It's where you decide what goes out, on which platform, and when — before approval.",
    lastUpdated: "2026-06-14",
    overview: [
      "A weekly plan is the planning surface for one week. Each item targets a platform and a time. The plan is deliberately a planning space, not a publish button: items only schedule after they pass approval.",
      "Working a week at a time keeps cadence calm and reviewable. You see the whole week, decide once, and let the scheduler carry it out.",
    ],
    bullets: [
      {
        heading: "An item carries",
        items: [
          "A target platform (and, for Reddit, a subreddit).",
          "The content to publish.",
          "A scheduled time.",
          "A status that moves from draft/queue → approved → scheduled → published.",
        ],
      },
    ],
    nextSteps: ["queue-scheduled-published", "how-approval-works"],
    related: ["first-weekly-plan", "understanding-the-workflow"],
    published: true,
  },
  {
    slug: "queue-scheduled-published",
    section: "weekly-plans",
    title: "Queue vs scheduled vs published",
    description:
      "The three states an item passes through, what each means, and what moves an item from one to the next.",
    lastUpdated: "2026-06-14",
    overview: [
      "Items move through three clear states. Knowing them tells you exactly what's waiting on you versus what Signal is handling for you.",
      "The boundary between queue and scheduled is the approval gate: an item only crosses it when a person approves it.",
    ],
    bullets: [
      {
        heading: "The states",
        items: [
          "Queue / awaiting approval — the item needs your review. It will not publish.",
          "Scheduled — approved and waiting for its time. The scheduler will publish it.",
          "Published — it went out; the outcome is recorded in publish history and visible in Results.",
        ],
      },
    ],
    commonMistakes: [
      "Leaving items in the queue and expecting them to publish — only approved items schedule.",
    ],
    prerequisites: ["what-is-a-weekly-plan"],
    nextSteps: ["how-approval-works"],
    related: ["publishing-status-reference", "publishing-lifecycle"],
    published: true,
  },
  {
    slug: "how-approval-works",
    section: "weekly-plans",
    title: "How approval works",
    description:
      "Approval is the single human gate in Signal. Nothing schedules or publishes until a person approves it — by design.",
    lastUpdated: "2026-06-14",
    overview: [
      "Approval is structural, not optional. Every item Signal surfaces is a recommendation; a person decides whether it goes out. There is no path through Signal that publishes without passing this gate.",
      "Approving an item moves it to scheduled. You can also adjust or set an item aside instead of approving it. The approval is recorded, so the audit trail shows who approved what.",
    ],
    bullets: [
      {
        heading: "At the gate you can",
        items: [
          "Approve an item — it becomes scheduled.",
          "Adjust the content or time before approving.",
          "Set an item aside so it doesn't go out this week.",
        ],
      },
    ],
    commonMistakes: [
      "Assuming bulk actions skip the gate — every published item was approved.",
      "Forgetting that reviewers can approve content but cannot change workspace settings or members.",
    ],
    prerequisites: ["queue-scheduled-published"],
    nextSteps: ["how-publishing-works"],
    related: ["reviewer-role", "approval-model", "mcp-approval-workflow"],
    published: true,
  },
];
