# Reddit command center

Route: [/platforms/reddit](../../src/app/(app)/platforms/reddit/page.tsx)

## Strategy

Community depth. Reddit is the platform where promotional posts age the worst. The goal is to be useful inside specific subreddits before referencing a product. Cadence is slower than the other platforms, link tolerance is lower, and warm-up is longer.

- **Voice:** calm, community-native, non-promotional.
- **Suggested cadence:** 2 posts per week.
- **Maximum cadence:** 4 posts per week.
- **Cooldown:** 36 hours between posts per account.
- **Link tolerance:** very low. Outbound links are exceptional, not routine.

## What you see on the page

- **Comments-first ratio panel** — the share of weekly Reddit items that are comments. The target is 60% or higher. Accounts that publish more than they comment age badly on Reddit.
- **Live recommendations** — pulled from the recommendations engine: warming accounts, promo load this week, blocked items, backlog availability.
- **Accounts** — Reddit accounts with eligibility and readiness, deep-linked to their detail pages.
- **Content queue** — Reddit items in the weekly plan, ordered by scheduled time, with risk chips.
- **Risk rules** — Reddit-specific signals the engine watches:
  - Direct link too early
  - Same domain repeated
  - Same subreddit repeated
  - Promotional wording
  - Low community fit
  - Account not warmed up
  - Too many posts vs comments
- **Playbook (10 modules)**:
  1. Subreddit intelligence (live)
  2. Community fit (live)
  3. Comments-first queue (live)
  4. Discussion post queue (live)
  5. No-link mode (passive)
  6. Link tolerance (passive)
  7. Promo risk (live)
  8. Cadence protection (live)
  9. Removal / moderator risk (placeholder for Reddit API)
  10. Account warm-up status (live)
- **Opportunities** — three subreddit suggestions per product, derived from product category.
- **Content formats** — helpful_comment, discussion_post, question_post, founder_lesson, soft_feedback_request.
- **Analytics placeholder** — "Data not yet connected" until WebmasterID is wired.
- **OAuth card** — explicit "not yet enabled"; lists what Signal will never ask for.

## What this command center never does

- Auto-post or auto-comment.
- Switch subreddits on the founder's behalf.
- Strip moderator removal warnings from Reddit's UI.
- Bypass karma minimums or new-account restrictions.

Reddit treats those moves as adversarial. Signal does not.
