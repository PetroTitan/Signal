import type { Article } from "../types";

export const workspace: Article[] = [
  // ---- Teams ----
  {
    slug: "invite-team-members",
    section: "teams",
    title: "Invite team members",
    description:
      "Invite teammates by email. They join via a one-time link; the invite expires and can be revoked. Existing accounts also get an in-app notification.",
    lastUpdated: "2026-06-14",
    overview: [
      "Owners and admins can invite people to a workspace by email. The invite carries a role and a one-time link. The recipient doesn't need a Signal account yet — they sign up (or sign in) and the invite completes when they open the link.",
      "Invites are pending until accepted, expire after a set window, and can be revoked while pending. If the email already has a Signal account, they also get an in-app notification.",
    ],
    steps: [
      { title: "Open Team settings", body: "Go to Settings → Team. Owners and admins see the invite controls." },
      { title: "Invite by email + role", body: "Enter the email and pick a role (admin, editor, reviewer, or viewer — not owner). Send the invite." },
      { title: "Share the link", body: "Copy the accept link to share. The recipient opens it while signed in to join the workspace." },
    ],
    bullets: [
      {
        heading: "Invite states",
        items: ["Pending — sent, not yet accepted.", "Accepted — the person joined.", "Expired — the window passed.", "Revoked — cancelled before acceptance."],
      },
    ],
    nextSteps: ["reviewer-role", "workspace-permissions"],
    related: ["ownership-transfer", "notifications-and-digests"],
    published: true,
  },
  {
    slug: "reviewer-role",
    section: "teams",
    title: "Reviewer role explained",
    description:
      "Reviewers can view and approve content and creative, but cannot change settings, members, platforms, billing, or transfer ownership.",
    lastUpdated: "2026-06-14",
    overview: [
      "The reviewer role exists for people who should approve work but not administer the workspace. A reviewer can view content and approve content and creative — exactly the approval gate — without the ability to change how the workspace is configured.",
    ],
    bullets: [
      {
        heading: "Reviewers can",
        items: ["View content and creative.", "Approve content.", "Approve creative."],
      },
      {
        heading: "Reviewers cannot",
        items: ["Change workspace settings.", "Manage members or invites.", "Connect platforms.", "Manage billing.", "Transfer ownership."],
      },
    ],
    prerequisites: ["invite-team-members"],
    related: ["workspace-permissions", "how-approval-works"],
    published: true,
  },
  {
    slug: "ownership-transfer",
    section: "teams",
    title: "Ownership transfer",
    description:
      "Transfer workspace ownership to another member with explicit confirmation. The workspace always keeps at least one owner.",
    lastUpdated: "2026-06-14",
    overview: [
      "An owner can transfer ownership to an existing member. The transfer requires explicit confirmation. To protect the workspace, the target is promoted to owner before the previous owner steps down to admin — so there is never a moment with zero owners.",
      "The transfer is audited and the new owner is notified.",
    ],
    steps: [
      { title: "Open Team settings", body: "Only the owner sees the transfer control." },
      { title: "Pick the new owner", body: "Choose an existing member. They must already be in the workspace." },
      { title: "Confirm", body: "Type the confirmation to proceed. Ownership moves; you become an admin." },
    ],
    commonMistakes: ["Trying to transfer to someone who isn't a member yet — invite them first."],
    prerequisites: ["invite-team-members"],
    related: ["workspace-permissions", "reviewer-role"],
    published: true,
  },
  {
    slug: "workspace-permissions",
    section: "teams",
    title: "Workspace permissions",
    description:
      "The role matrix: owner, admin, editor, reviewer, viewer — and exactly what each can do.",
    lastUpdated: "2026-06-14",
    overview: [
      "Roles map to a fixed set of permissions, and higher roles include everything the lower ones can do. This keeps access predictable: you can hand someone exactly the capability they need and nothing more.",
    ],
    bullets: [
      {
        heading: "Roles",
        items: [
          "Viewer — view content.",
          "Reviewer — view + approve content and creative.",
          "Editor — reviewer + edit content.",
          "Admin — editor + manage members, settings, platforms, and invites.",
          "Owner — admin + billing + transfer ownership.",
        ],
      },
    ],
    prerequisites: ["reviewer-role"],
    related: ["invite-team-members", "ownership-transfer", "approval-model"],
    published: true,
  },
  {
    slug: "notifications-and-digests",
    section: "teams",
    title: "Notifications and digests",
    description:
      "How team activity surfaces as notifications and optional digests, per person and per workspace.",
    lastUpdated: "2026-06-14",
    overview: [
      "Team and operational events surface in the notification center, and each person can opt into a digest. Preferences are per person, per workspace, so teammates control their own delivery.",
    ],
    bullets: [
      {
        heading: "How team members stay informed",
        items: [
          "In-app notifications for invitations, acceptances, and ownership transfers.",
          "An optional daily or weekly digest of real operational state.",
          "Per-person control — each teammate sets their own channels and cadence.",
        ],
      },
    ],
    related: ["notification-center", "scheduled-digests", "notification-preferences"],
    published: true,
  },

  // ---- Notifications ----
  {
    slug: "notification-center",
    section: "notifications",
    title: "The notification center",
    description:
      "A recipient-scoped feed of real operational events — failures, blocks, expiring connections, and team events — each linking to the entity it's about.",
    lastUpdated: "2026-06-14",
    overview: [
      "The notification center is your feed of things that actually need attention: a post that failed, a blocked item, a connection about to expire, an invitation, an ownership transfer. Every notification reflects real state and links straight to the entity it's about.",
      "Notifications are recipient-scoped — you only see your own — and reconciled from source-of-truth, so opening the center never invents alerts.",
    ],
    bullets: [
      {
        heading: "Event types",
        items: [
          "Publish failed / retries exhausted.",
          "Publish blocked.",
          "Stale claim (interrupted publish).",
          "Connection expiring.",
          "Invitation received / accepted, ownership transferred.",
        ],
      },
    ],
    nextSteps: ["notification-preferences", "scheduled-digests"],
    related: ["understanding-failed-posts", "telegram-notifications"],
    published: true,
  },
  {
    slug: "scheduled-digests",
    section: "notifications",
    title: "Scheduled digests",
    description:
      "An optional daily or weekly digest of real pipeline counts, delivered to your enabled channels. Never engagement estimates.",
    lastUpdated: "2026-06-14",
    overview: [
      "A digest is a periodic summary of your real operational state — counts of unread notifications by type. You choose daily, weekly, or disabled. The digest is built from real data only; it never includes fabricated engagement.",
      "Digests are delivered on a schedule to the channels you've enabled. If you have no channel enabled, the digest is simply previewable in the app.",
    ],
    bullets: [
      {
        heading: "Good to know",
        items: [
          "Cadence is per person: daily, weekly, or disabled.",
          "An empty digest isn't sent — if there's nothing to report, you get nothing.",
          "Sending a digest never marks your notifications as read.",
        ],
      },
    ],
    prerequisites: ["notification-center"],
    nextSteps: ["notification-preferences"],
    related: ["telegram-notifications"],
    published: true,
  },
  {
    slug: "telegram-notifications",
    section: "notifications",
    title: "Telegram notifications",
    description:
      "Signal can deliver your digest to Telegram using the existing bot, to an operator-configured chat.",
    lastUpdated: "2026-06-14",
    overview: [
      "If Telegram is configured for your workspace, you can have the digest delivered there. It reuses the existing Telegram bot — it doesn't add any new publishing behavior — and sends to the chat the operator configured.",
      "If the bot token or target chat isn't configured, the Telegram channel is simply skipped (reported as not configured) rather than failing your digest.",
    ],
    prerequisites: ["scheduled-digests"],
    related: ["notification-preferences", "notification-center"],
    published: true,
  },
  {
    slug: "notification-preferences",
    section: "notifications",
    title: "Notification preferences",
    description:
      "Turn email and Telegram on or off, set digest cadence, and choose how many days before a connection expires you're warned.",
    lastUpdated: "2026-06-14",
    overview: [
      "Preferences are per person, per workspace. You control which channels are on, your digest cadence, and your connection-expiry warning window.",
    ],
    bullets: [
      {
        heading: "What you control",
        items: [
          "Email digest on/off (email delivery is not wired to a provider yet — content is previewable).",
          "Telegram digest on/off.",
          "Digest cadence: daily, weekly, or disabled.",
          "Connection-expiry warning window (0–30 days).",
        ],
      },
    ],
    prerequisites: ["notification-center"],
    related: ["scheduled-digests", "telegram-notifications"],
    published: true,
  },

  // ---- MCP ----
  {
    slug: "what-is-mcp",
    section: "mcp",
    title: "What is Signal MCP",
    description:
      "Signal exposes an MCP bridge so an AI client like Claude can read and prepare work in your workspace — always behind the same approval gate.",
    lastUpdated: "2026-06-14",
    overview: [
      "MCP (Model Context Protocol) lets an AI client like Claude connect to Signal as a tool. Through the bridge, the assistant can read your workspace and prepare items — but it cannot bypass approval. Anything that would publish still passes through the human gate.",
      "The bridge authenticates with a scoped bearer token you create, not your login session, and every tool call is scoped to that token's workspace and audited.",
    ],
    bullets: [
      {
        heading: "Principles",
        items: [
          "Token-scoped — a bearer token bound to one workspace, not your cookie session.",
          "Audited — every tool call is recorded.",
          "Approval-preserving — the assistant cannot publish without the same approval as the UI.",
        ],
      },
    ],
    nextSteps: ["mcp-token-guide", "mcp-security-model"],
    related: ["mcp-approval-workflow", "mcp-connection-problems"],
    published: true,
  },
  {
    slug: "mcp-token-guide",
    section: "mcp",
    title: "MCP token guide",
    description:
      "Create, name, and revoke MCP tokens from settings. A token scopes an AI client to one workspace and can be revoked anytime.",
    lastUpdated: "2026-06-14",
    overview: [
      "An MCP token is how an AI client authenticates to Signal. You create it in Settings → MCP → Tokens, give it a name, and use it as the bearer token in your client's MCP configuration. Tokens are scoped to the workspace they're created in and can be renamed or revoked at any time.",
    ],
    steps: [
      { title: "Open Settings → MCP → Tokens", body: "You'll see existing tokens and a create control." },
      { title: "Create and copy the token", body: "Name it for the client you'll use it with (e.g. \"Claude Desktop\"). Copy it now — it's shown once." },
      { title: "Revoke when done", body: "Revoke a token to immediately cut off any client using it." },
    ],
    commonMistakes: ["Sharing one token across many clients — create one per client so you can revoke precisely."],
    prerequisites: ["what-is-mcp"],
    nextSteps: ["mcp-security-model", "mcp-approval-workflow"],
    related: ["mcp-connection-problems"],
    published: true,
  },
  {
    slug: "mcp-security-model",
    section: "mcp",
    title: "MCP security model",
    description:
      "How the bridge stays safe: bearer-token auth, per-workspace scoping, audited tool calls, and no path around approval.",
    lastUpdated: "2026-06-14",
    overview: [
      "The MCP bridge has its own security model, separate from your browser session. It authenticates with a scoped bearer token, scopes every query to that token's workspace, audits every call, and never exposes a path that publishes without approval.",
    ],
    bullets: [
      {
        heading: "Controls",
        items: [
          "Bearer token, not a cookie — the bridge never rides your browser session.",
          "Workspace scoping — a token can only touch its own workspace's data.",
          "Audit trail — every tool call is recorded.",
          "Approval preserved — actions that publish still require the human gate.",
        ],
      },
    ],
    prerequisites: ["mcp-token-guide"],
    nextSteps: ["mcp-approval-workflow"],
    related: ["what-is-mcp", "approval-model", "security-overview"],
    published: true,
  },
  {
    slug: "mcp-approval-workflow",
    section: "mcp",
    title: "MCP approval workflow",
    description:
      "Work prepared through MCP lands in the same queue and passes the same approval gate as anything created in the app.",
    lastUpdated: "2026-06-14",
    overview: [
      "MCP doesn't get a shortcut. When an assistant prepares an item through the bridge, that item enters the same pipeline as work created in the UI — it waits in the queue for human approval before it can schedule or publish.",
      "This is the whole point of the design: you can let an assistant help you prepare a week of content, and still review every item yourself before anything goes out.",
    ],
    prerequisites: ["mcp-security-model"],
    related: ["how-approval-works", "approval-model"],
    published: true,
  },
  {
    slug: "mcp-connection-problems",
    section: "mcp",
    title: "MCP connection problems",
    description:
      "Fix the common reasons an AI client can't connect to Signal's MCP bridge: token, URL, or revocation.",
    lastUpdated: "2026-06-14",
    overview: [
      "Most MCP connection issues come down to the bearer token or the endpoint URL configured in your AI client. Work through the cases below before changing anything else in your setup.",
    ],
    troubleshooting: [
      { problem: "401 / unauthorized from the bridge.", fix: "The bearer token is missing, mistyped, or revoked. Create a fresh token in Settings → MCP → Tokens and update your client config." },
      { problem: "The client connects but sees no workspace data.", fix: "The token is scoped to a different workspace than you expect. Create the token from the workspace whose data you want." },
      { problem: "503 from the bridge.", fix: "The server-side persistence isn't configured in that environment. This is an environment/config issue, not your token." },
    ],
    prerequisites: ["mcp-token-guide"],
    related: ["what-is-mcp", "mcp-security-model"],
    published: true,
  },
];
