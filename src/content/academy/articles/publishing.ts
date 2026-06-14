import type { Article } from "../types";

export const publishing: Article[] = [
  {
    slug: "how-publishing-works",
    section: "publishing",
    title: "How Signal publishing works",
    description:
      "The scheduler runs on a timer, claims each due item so it can't double-publish, sends it to the platform, and records the outcome.",
    lastUpdated: "2026-06-14",
    overview: [
      "Signal publishes with a lightweight scheduler. There's no always-on worker you manage — a tick runs on a timer, finds approved items whose time has arrived, and publishes them one batch at a time.",
      "Each tick is bounded and idempotent: it processes whatever is eligible at call time. If a tick is interrupted, the next one picks up safely because every item is claimed before it's published.",
    ],
    bullets: [
      {
        heading: "What a tick does",
        items: [
          "Finds items in scheduled state whose time is due.",
          "Claims each item (scheduled → running) so two ticks can't publish the same post.",
          "Sends the content to the platform adapter and records the outcome.",
          "Writes publish history with the real permalink and timing.",
        ],
      },
    ],
    nextSteps: ["publishing-lifecycle", "publishing-reliability"],
    related: ["how-approval-works", "understanding-results"],
    published: true,
  },
  {
    slug: "publishing-lifecycle",
    section: "publishing",
    title: "Publishing lifecycle explained",
    description:
      "An item's full journey: pending approval → scheduled → running (claimed) → completed, failed, or blocked.",
    lastUpdated: "2026-06-14",
    overview: [
      "Every item moves through a small, explicit state machine. Each state means something specific and tells you whether Signal or you owns the next move.",
    ],
    bullets: [
      {
        heading: "States",
        items: [
          "Pending approval — waiting on you. Won't publish.",
          "Scheduled — approved, waiting for its time.",
          "Running — claimed by a scheduler tick and being published right now.",
          "Completed — published successfully; recorded in history.",
          "Failed — the platform rejected it or an error occurred after retries.",
          "Blocked — a policy or readiness gate stopped it (e.g. missing required media).",
        ],
      },
    ],
    commonMistakes: [
      "Reading \"running\" as stuck. It's normal during a publish; only a long-lived running item is a stale claim.",
    ],
    prerequisites: ["how-publishing-works"],
    nextSteps: ["publishing-status-reference"],
    related: ["understanding-failed-posts", "understanding-stale-claims", "publishing-reliability"],
    published: true,
  },
  {
    slug: "publishing-reliability",
    section: "publishing",
    title: "The publishing reliability system",
    description:
      "Claims prevent double-posting, retries absorb transient errors, and stale-claim detection surfaces interrupted publishes for manual recovery.",
    lastUpdated: "2026-06-14",
    overview: [
      "Publishing to third-party platforms is unreliable by nature: networks time out, APIs rate-limit, tokens expire. Signal's reliability system is built so those realities never turn into a double-post or a silently lost post.",
      "Three mechanisms work together: an atomic claim before each publish, a retry policy with backoff for transient failures, and stale-claim detection for the rare case where a publish is interrupted mid-flight.",
    ],
    bullets: [
      {
        heading: "The guarantees",
        items: [
          "No double-publish — an item is claimed (scheduled → running) with a guarded update; only one tick can win the claim.",
          "Transient errors retry — a timeout or 5xx is retried with backoff, not failed immediately.",
          "Interruptions are visible — if a tick dies mid-publish, the item is left as a stale claim and surfaced for manual recovery rather than blindly re-published.",
        ],
      },
    ],
    prerequisites: ["publishing-lifecycle"],
    nextSteps: ["retry-and-backoff", "understanding-stale-claims"],
    related: ["understanding-failed-posts", "publishing-reliability-trust"],
    published: true,
  },
  {
    slug: "retry-and-backoff",
    section: "publishing",
    title: "Retry and backoff explained",
    description:
      "When a publish hits a transient error, Signal retries with increasing delay up to a bounded number of attempts before marking it failed.",
    lastUpdated: "2026-06-14",
    overview: [
      "Not every publishing error is permanent. A network timeout or a temporary platform 5xx usually succeeds on a second try. Signal distinguishes transient errors (worth retrying) from permanent ones (a malformed request, a revoked token) and only retries the transient ones.",
      "Retries are bounded and use backoff — each attempt waits longer than the last — so a struggling platform isn't hammered and a genuinely broken item doesn't loop forever. After the attempt budget is exhausted, the item is marked failed and surfaced to you.",
    ],
    bullets: [
      {
        heading: "Retried vs not retried",
        items: [
          "Retried: timeouts, transient 5xx, token-refresh hiccups.",
          "Not retried: permanent rejections like a malformed payload or a policy block — retrying wouldn't help.",
        ],
      },
    ],
    commonMistakes: [
      "Manually retrying a permanently-failed item without fixing the cause — it will fail the same way.",
    ],
    prerequisites: ["publishing-reliability"],
    nextSteps: ["understanding-failed-posts"],
    related: ["understanding-stale-claims", "publishing-status-reference"],
    published: true,
  },
  {
    slug: "understanding-failed-posts",
    section: "publishing",
    title: "Understanding failed posts",
    description:
      "A failed post is one the platform rejected or that errored after retries. Failed items are always visible and can be retried after you fix the cause.",
    lastUpdated: "2026-06-14",
    overview: [
      "A failed post is never lost or hidden. When an item exhausts its retries or hits a permanent error, it's marked failed and surfaced so you can decide what to do.",
      "Failed items can be retried manually. Because the original approval still stands and a manual retry returns the item to scheduled (the same state it held at approval), retrying never bypasses the approval gate.",
    ],
    steps: [
      {
        title: "Find the failure reason",
        body: "Open the item. Signal records why it failed — a platform error code, a rejected payload, or an expired connection.",
      },
      {
        title: "Fix the cause",
        body: "Reconnect an expired account, adjust content the platform rejected, or wait out a rate limit.",
      },
      {
        title: "Retry",
        body: "Use the retry control. The item returns to scheduled and the next tick attempts it again with a fresh attempt budget.",
      },
    ],
    commonMistakes: [
      "Retrying without changing anything when the cause was permanent.",
      "Assuming a failed post might have partially published — check the platform; if it's already live, see stale claims.",
    ],
    prerequisites: ["retry-and-backoff"],
    nextSteps: ["understanding-stale-claims"],
    related: ["failed-posts", "publishing-status-reference"],
    published: true,
  },
  {
    slug: "understanding-stale-claims",
    section: "publishing",
    title: "Understanding stale claims",
    description:
      "A stale claim is an item stuck in running because a publish was interrupted. Recovery is manual on purpose, because the post may already be live.",
    lastUpdated: "2026-06-14",
    overview: [
      "When the scheduler claims an item it moves to running. Almost always it finishes within seconds. If a tick is killed after the claim but before the outcome is recorded, the item stays running — that's a stale claim.",
      "Signal surfaces a running item that has been claimed for too long as a stale claim rather than automatically re-publishing it. The reason is safety: the provider call may have actually succeeded before the interruption, so auto-retrying could double-post. Recovery is deliberately a manual decision.",
    ],
    steps: [
      {
        title: "Check the platform",
        body: "Look at the target account. Did the post actually go out? The claim records enough detail to investigate.",
      },
      {
        title: "Recover deliberately",
        body: "If it didn't publish, retry it. If it did, mark it resolved so it isn't published again.",
      },
    ],
    commonMistakes: [
      "Force-retrying a stale claim without checking the platform first — that's exactly how a double-post happens.",
    ],
    prerequisites: ["publishing-reliability"],
    nextSteps: ["publishing-status-reference"],
    related: ["understanding-failed-posts", "how-signal-prevents-accidental-publishing"],
    published: true,
  },
  {
    slug: "publishing-status-reference",
    section: "publishing",
    title: "Publishing status reference",
    description:
      "A quick reference for every publishing status you'll see and what action, if any, it asks of you.",
    lastUpdated: "2026-06-14",
    overview: [
      "Every item carries a status that tells you where it is in the pipeline and whether the next move is yours or Signal's. Use this page as a quick lookup when a status isn't self-explanatory.",
    ],
    bullets: [
      {
        heading: "Statuses",
        items: [
          "Pending approval — waiting on you; approve to schedule.",
          "Scheduled — approved; the scheduler will publish at the set time.",
          "Running — being published now; normal, transient.",
          "Completed — published; see Results for the permalink.",
          "Failed — rejected or errored after retries; fix and retry.",
          "Blocked — a readiness or policy gate stopped it; resolve the gate (e.g. add required media).",
          "Stale claim — running too long after an interruption; check the platform before recovering.",
        ],
      },
    ],
    prerequisites: ["publishing-lifecycle"],
    related: ["understanding-failed-posts", "understanding-stale-claims", "queue-scheduled-published"],
    published: true,
  },
];
