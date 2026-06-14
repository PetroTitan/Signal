import type { Article } from "../types";

export const platforms: Article[] = [
  // ---- Bluesky ----
  {
    slug: "connect-bluesky",
    section: "bluesky",
    title: "Connect Bluesky",
    description:
      "Connect Bluesky with an app password (not your main password). Signal verifies the handle and stores the credential encrypted.",
    lastUpdated: "2026-06-14",
    overview: [
      "Bluesky connects with an app password — a scoped credential you generate in Bluesky's settings. Signal never asks for your main Bluesky password.",
    ],
    steps: [
      {
        title: "Create an app password in Bluesky",
        body: "In Bluesky, go to Settings → App Passwords and create one for Signal. Copy it; you won't see it again.",
      },
      {
        title: "Add the Bluesky identity in Signal",
        body: "On Accounts, choose Bluesky, enter your handle, and paste the app password. Signal resolves the handle to confirm the account.",
      },
      {
        title: "Verify",
        body: "Signal verifies the session. A handle mismatch is surfaced rather than allowing a wrong-account publish.",
      },
    ],
    troubleshooting: [
      {
        problem: "\"credentials missing\" when connecting.",
        fix: "The app password field was empty or whitespace. Re-generate the app password in Bluesky and paste it again.",
      },
    ],
    related: ["publish-to-bluesky", "bluesky-metrics", "bluesky-authentication-problems"],
    externalRefs: [{ label: "Bluesky app passwords", href: "https://bsky.app/settings/app-passwords" }],
    published: true,
  },
  {
    slug: "publish-to-bluesky",
    section: "bluesky",
    title: "Publish to Bluesky",
    description:
      "How Bluesky posts and threads go out, and how Signal prepares media into a provider-safe form before publishing.",
    lastUpdated: "2026-06-14",
    overview: [
      "Once Bluesky is connected, scheduled Bluesky items publish like any other: the scheduler claims, posts, and records the result. Bluesky supports single posts and threads.",
      "If a post includes an image, Signal prepares it into a provider-safe derivative before publishing (see Media derivatives) so it meets Bluesky's constraints. Required alt text is validated before the post is allowed out.",
    ],
    bullets: [
      {
        heading: "Good to know",
        items: [
          "Threads publish as a connected sequence of posts.",
          "Images are transcoded to a provider-safe derivative automatically.",
          "Missing required alt text blocks the post rather than publishing inaccessible media.",
        ],
      },
    ],
    related: ["bluesky-thread-publishing", "media-derivatives", "fixing-creative-validation-errors"],
    published: true,
  },
  {
    slug: "bluesky-thread-publishing",
    section: "bluesky",
    title: "Bluesky thread publishing",
    description:
      "Signal publishes Bluesky threads as a linked sequence of posts, recording the root permalink in publish history.",
    lastUpdated: "2026-06-14",
    overview: [
      "A Bluesky thread is published as multiple posts linked in reply order. Signal handles the sequence as one item, so a thread either publishes as a unit or surfaces a clear failure if a part is rejected.",
      "Because the thread is one execution item, the same reliability guarantees apply: it's claimed once before publishing, and an interrupted thread surfaces as a stale claim for manual recovery rather than being re-posted blindly.",
    ],
    bullets: [
      {
        heading: "Good to know",
        items: [
          "Posts publish in order, each replying to the previous.",
          "The root post's permalink is recorded in publish history.",
          "If a later post in the thread is rejected, the item is marked failed with the reason.",
        ],
      },
    ],
    related: ["publish-to-bluesky", "bluesky-metrics", "understanding-stale-claims"],
    published: true,
  },
  {
    slug: "bluesky-metrics",
    section: "bluesky",
    title: "Bluesky metrics explained",
    description:
      "Signal reads likes, reposts, replies, and quotes for Bluesky posts from Bluesky's public app-view — real counts, never estimates.",
    lastUpdated: "2026-06-14",
    overview: [
      "Bluesky is a verified metrics platform in Signal. After a post publishes, Signal reads its engagement from Bluesky's public app-view API and shows the real counts.",
    ],
    bullets: [
      {
        heading: "What's read",
        items: ["Likes", "Reposts", "Replies", "Quotes"],
      },
    ],
    related: ["metrics-refresh", "supported-metrics-by-platform", "results-intelligence"],
    published: true,
  },

  // ---- Reddit ----
  {
    slug: "connect-reddit",
    section: "reddit",
    title: "Connect Reddit",
    description:
      "Reddit connects through its official OAuth flow. Signal requests scopes explicitly and stores tokens encrypted, revocable from the app.",
    lastUpdated: "2026-06-14",
    overview: [
      "Reddit connects through OAuth — you authorize Signal on Reddit's own consent screen. Signal never sees your Reddit password. Tokens are stored encrypted and can be disconnected from Accounts at any time.",
    ],
    steps: [
      {
        title: "Start the Reddit connection",
        body: "On Accounts, choose Reddit and start the authorization. You'll be sent to Reddit to approve the requested scopes.",
      },
      {
        title: "Approve on Reddit",
        body: "Reddit shows exactly what Signal is asking for. Approve to return to Signal with a connected account.",
      },
    ],
    related: ["reddit-publishing-workflow", "reddit-api-limitations", "reddit-metrics"],
    published: true,
  },
  {
    slug: "reddit-publishing-workflow",
    section: "reddit",
    title: "Reddit publishing workflow",
    description:
      "Reddit items target a specific subreddit. Approve, schedule, and the scheduler submits the post; the permalink is recorded on success.",
    lastUpdated: "2026-06-14",
    overview: [
      "A Reddit item targets a specific subreddit. Beyond that it follows the standard flow: approve, schedule, publish, record. The subreddit's own rules still apply — Signal submits the post but cannot override a subreddit's posting requirements.",
    ],
    commonMistakes: [
      "Targeting a subreddit you don't meet the posting requirements for; the submission will be rejected by Reddit, not Signal.",
    ],
    related: ["connect-reddit", "reddit-api-limitations", "reddit-metrics"],
    published: true,
  },
  {
    slug: "reddit-api-limitations",
    section: "reddit",
    title: "Reddit API limitations",
    description:
      "What Reddit's API does and doesn't allow, and how those limits shape publishing and metrics in Signal.",
    lastUpdated: "2026-06-14",
    overview: [
      "Reddit's API enforces rate limits and per-subreddit rules that Signal cannot bypass. A submission that violates a subreddit's rules (account age, karma, flair requirements) is rejected by Reddit. Signal surfaces the rejection rather than retrying a request that can't succeed.",
      "For metrics, Signal reads a post's public score and comment count from Reddit's official JSON for that post — no private analytics are required.",
    ],
    related: ["reddit-publishing-workflow", "reddit-metrics", "understanding-failed-posts"],
    published: true,
  },
  {
    slug: "reddit-metrics",
    section: "reddit",
    title: "Reddit metrics explained",
    description:
      "Signal reads a Reddit post's score and comment count from the official public JSON — verified counts only.",
    lastUpdated: "2026-06-14",
    overview: [
      "Reddit is a verified metrics platform. Signal reads each post's score and number of comments from Reddit's official public JSON endpoint for that post.",
    ],
    bullets: [{ heading: "What's read", items: ["Score", "Comments"] }],
    related: ["metrics-refresh", "supported-metrics-by-platform"],
    published: true,
  },

  // ---- X ----
  {
    slug: "connect-x",
    section: "x",
    title: "Connect X",
    description:
      "X connects through OAuth. Signal requests scopes explicitly and stores tokens encrypted, revocable from the app.",
    lastUpdated: "2026-06-14",
    overview: [
      "X connects through its official OAuth flow. You approve Signal on X's consent screen; Signal never handles your X password. Tokens are encrypted at rest and revocable from Accounts.",
    ],
    steps: [
      { title: "Start the X connection", body: "On Accounts, choose X and start the authorization. You'll be redirected to X to approve." },
      { title: "Approve on X", body: "X shows the scopes Signal requests. Approve to return with a connected account." },
      { title: "Disconnect anytime", body: "Revoke the connection from Accounts; Signal clears the stored tokens." },
    ],
    related: ["x-publishing-workflow", "x-metrics-availability"],
    published: true,
  },
  {
    slug: "x-publishing-workflow",
    section: "x",
    title: "X publishing workflow & media",
    description:
      "How X posts publish in Signal, including media preparation into a provider-safe derivative before the post goes out.",
    lastUpdated: "2026-06-14",
    overview: [
      "Connected X items follow the standard flow: approve, schedule, publish, record. When a post includes an image, Signal prepares a provider-safe derivative first so it meets X's media constraints.",
      "Publishing reliability applies the same way as every platform: the item is claimed before it's sent, transient errors retry with backoff, and the result is written to publish history with the real permalink.",
    ],
    related: ["connect-x", "media-derivatives", "x-metrics-availability"],
    published: true,
  },
  {
    slug: "x-metrics-availability",
    section: "x",
    title: "X metrics availability",
    description:
      "X post metrics require an elevated/paid API tier. On the standard integration Signal shows \"Unavailable\" rather than estimating.",
    lastUpdated: "2026-06-14",
    overview: [
      "Reading post metrics from X requires an elevated, paid API tier. Signal's standard integration does not have that access, so X metrics are marked Unavailable — with an explanation — instead of being estimated or scraped.",
      "This is deliberate: Signal would rather show you an honest \"Unavailable\" than a fabricated number.",
    ],
    related: ["why-metrics-unavailable", "supported-metrics-by-platform"],
    published: true,
  },

  // ---- dev.to ----
  {
    slug: "connect-devto",
    section: "devto",
    title: "Connect dev.to",
    description:
      "Connect dev.to with a personal API key from your dev.to settings. Signal stores it encrypted and uses it to publish articles.",
    lastUpdated: "2026-06-14",
    overview: [
      "dev.to connects with a personal API key you generate in your dev.to account settings. Paste it into Signal on the Accounts page; it's stored encrypted and used to publish articles to your account.",
    ],
    steps: [
      {
        title: "Generate an API key in dev.to",
        body: "In dev.to, open Settings → Extensions / API keys and generate a key.",
      },
      {
        title: "Add the dev.to identity in Signal",
        body: "On Accounts, choose dev.to and paste the key.",
      },
    ],
    related: ["publish-articles-to-devto", "devto-metrics"],
    published: true,
  },
  {
    slug: "publish-articles-to-devto",
    section: "devto",
    title: "Publish articles to dev.to",
    description:
      "dev.to is article-shaped: a title and a markdown body. Signal preserves your markdown verbatim and publishes via the dev.to API.",
    lastUpdated: "2026-06-14",
    overview: [
      "dev.to posts are articles, not short social posts. An item needs a title and a markdown body. Signal preserves the markdown body verbatim — it doesn't strip or rewrite it — and submits it through the dev.to API.",
    ],
    commonMistakes: [
      "Leaving the article title empty — dev.to requires a title.",
      "Expecting social-post formatting; dev.to is long-form markdown.",
    ],
    related: ["connect-devto", "devto-metrics"],
    published: true,
  },
  {
    slug: "devto-metrics",
    section: "devto",
    title: "dev.to metrics explained",
    description:
      "Signal reads public reactions and comments for a dev.to article from the public API. View counts are author-only and aren't shown.",
    lastUpdated: "2026-06-14",
    overview: [
      "dev.to is a verified metrics platform for the counts it exposes publicly: an article's public reactions and comments. Signal reads these from dev.to's public article API.",
      "Page views are not part of dev.to's public response (they're author-only in the dashboard), so Signal does not show a view count rather than inventing one.",
    ],
    bullets: [{ heading: "What's read", items: ["Public reactions", "Comments"] }],
    related: ["metrics-refresh", "supported-metrics-by-platform"],
    published: true,
  },

  // ---- Hashnode ----
  {
    slug: "connect-hashnode",
    section: "hashnode",
    title: "Connect Hashnode",
    description:
      "Connect Hashnode with a personal access token and select the publication articles should post to.",
    lastUpdated: "2026-06-14",
    overview: [
      "Hashnode connects with a personal access token from your Hashnode settings, plus the publication you want articles to post to. Hashnode articles always belong to a publication, so the publication is required.",
    ],
    steps: [
      { title: "Create a token in Hashnode", body: "Generate a personal access token in your Hashnode developer settings." },
      { title: "Add the identity and publication", body: "On Accounts, choose Hashnode, paste the token, and select the target publication." },
    ],
    commonMistakes: ["Connecting a token without selecting a publication — articles have nowhere to go."],
    related: ["publish-to-hashnode", "hashnode-metrics-availability"],
    published: true,
  },
  {
    slug: "publish-to-hashnode",
    section: "hashnode",
    title: "Publish to Hashnode",
    description:
      "Hashnode items are articles published to your selected publication through Hashnode's API.",
    lastUpdated: "2026-06-14",
    overview: [
      "A Hashnode item is an article — a title and markdown body — published to the publication you connected. It follows the standard approve → schedule → publish flow.",
    ],
    bullets: [
      {
        heading: "Good to know",
        items: [
          "Articles always belong to the publication you selected when connecting.",
          "The markdown body is preserved as written.",
          "Publishing is reliable (claim + retry); the result is recorded in publish history.",
        ],
      },
    ],
    related: ["connect-hashnode", "hashnode-metrics-availability"],
    published: true,
  },
  {
    slug: "hashnode-metrics-availability",
    section: "hashnode",
    title: "Hashnode metrics availability",
    description:
      "Hashnode analytics require a GraphQL query Signal hasn't integrated yet, so Hashnode metrics show as \"Unavailable\" — never estimated.",
    lastUpdated: "2026-06-14",
    overview: [
      "Hashnode publishing is fully supported, but reading post analytics requires a Hashnode GraphQL query that isn't integrated into Signal yet. Until it is, Hashnode metrics are marked Unavailable with that explanation, rather than estimated.",
      "\"Unavailable\" is deliberate and honest: the data exists on Hashnode's side, but Signal won't display a number it can't verify through an integrated source. When the analytics query is wired up, Hashnode will move to a verified state.",
    ],
    related: ["why-metrics-unavailable", "supported-metrics-by-platform"],
    published: true,
  },
];
