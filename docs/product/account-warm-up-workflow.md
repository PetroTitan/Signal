# Account warm-up workflow

Every Signal account ships with a 14-day warm-up plan. It is the bridge between a freshly created account and one that is safe for the weekly plan.

The generators live in [src/core/onboarding/kits.ts](../../src/core/onboarding/kits.ts) under `warmUpDays`.

## Why 14 days

Two weeks is long enough for platform signals to settle, for the founder to find the right voice, and for the audience to recognize the account as real. Shorter warm-ups produce accounts that look like brand accounts on day three.

## Day structure

Each day has:

- `day`: 1..14
- `focus`: one of `observation`, `comments`, `replies`, `first_post`, `thread`, `long_form`
- `description`: a single-line instruction the founder can execute that day

## Platform-specific shape

### Reddit (14 days)

- Days 1–2: pure observation. Subscribe and read.
- Days 3–6: comments only. No links. No product mentions.
- Day 7: quiet reading day.
- Days 8–9: more comments, mapped to subreddits the account has earned presence in.
- Day 10: first helpful, link-free post.
- Day 11: reply to every reply on day 10.
- Day 12: quiet day; gather angles.
- Day 13: second discussion post, link-free.
- Day 14: replies; account is now warm enough for the weekly plan.

### X (14 days)

- Days 1–3: read and reply. No top-level posts yet.
- Day 4: first short post.
- Days 5–7: reply-heavy days mixed with one quiet day.
- Day 8: second short post.
- Day 9: first thread, 4–6 posts, ending on a question.
- Day 10: spend the day in the replies under the thread.
- Day 11: quiet day for drafts.
- Day 12: short post calibrated to what worked.
- Day 13: second thread, grounded in one concrete number.
- Day 14: reply through the day; account ready.

### LinkedIn (14 days)

- Day 1: curate the feed (mute generic motivation; follow operators).
- Days 2–4: thoughtful comments. Reply to everyone on the comments you leave.
- Day 5: first short post (an observation).
- Day 6: reply to every comment.
- Day 7: quiet reading day.
- Day 8: another round of three comments.
- Day 9: second short post (a lesson, not a launch).
- Day 10: replies; build relationships over reach.
- Day 11: draft a long-form essay.
- Day 12: quiet editing day.
- Day 13: publish the long-form essay (no product link).
- Day 14: replies through the day; account ready.

## Where the warm-up surfaces

- The wizard preview shows the first four days.
- The account detail page renders all 14 days in a two-column grid with the day number, focus tag, and description.

## After warm-up

When the founder marks an account ready for planning, eligibility flips on. The account becomes available to the weekly plan. The risk engine still flags `warming`-state items as needing soft tone — being eligible is not the same as being unrestricted.

## Re-warming

If an account is paused for a long time, restart the warm-up. The current MVP does not automate this; the founder simply re-runs the plan by setting the account back to `awaiting_manual_creation` or `setup_needed` and refreshing the kit.
