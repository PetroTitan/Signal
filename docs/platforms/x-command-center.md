# X command center

Route: [/platforms/x](../../src/app/(app)/platforms/x/page.tsx)

## Strategy

Founder voice and distribution. X rewards consistency more than volume. The plan favors replies and short observations over launches and link drops. Threads are deliberate. Pinned content is reserved for a single calibrated thread per product.

- **Voice:** sharp, concise, founder-native — not hypey.
- **Suggested cadence:** 7 posts per week (replies are unlimited).
- **Maximum cadence:** 14 posts per week.
- **Cooldown:** 6 hours between posts per account.
- **Link tolerance:** low. One outbound link per day per account at most.

## What you see on the page

- **Format mix panel** — replies, short posts, threads, and long-form / story counts as four tiles. Three or more threads triggers a soft warning.
- **Account velocity panel** — per-account weekly count against suggested cadence. Accounts over suggested get an amber bar and a "slow this account next week" hint.
- **Live recommendations** — pulled from the recommendations engine: no replies scheduled, thread density too high, posting bursts, backlog availability.
- **Accounts** — X accounts with eligibility and readiness.
- **Content queue** — X items in the weekly plan, ordered by time, with risk chips.
- **Risk rules** — X-specific signals:
  - Too many links
  - Repetitive hooks
  - Overly promotional launch wording
  - Posting bursts
  - Same product repeated
  - Reply spam pattern
- **Playbook (10 modules)**:
  1. Hook bank (passive)
  2. Thread queue (live)
  3. Short post queue (live)
  4. Reply strategy (live)
  5. Founder voice (passive)
  6. Build-in-public ideas (passive)
  7. Timing windows (live)
  8. Engagement follow-up (passive)
  9. Pinned post (placeholder for X API)
  10. Account velocity control (live)
- **Opportunities** — hook seeds, thread seeds, and a daily reply target generated from product profiles.
- **Content formats** — short_post, thread, reply, founder_observation, build_in_public_update, product_micro_story.
- **Analytics placeholder** — "Data not yet connected".
- **OAuth card** — explicit "not yet enabled".

## What this command center never does

- Schedule reply spam patterns. Replies must be written one at a time.
- Suggest identical hooks across accounts.
- Burst-post (>1 post within 60 minutes from the same account).
- Auto-pin or auto-unpin threads.
