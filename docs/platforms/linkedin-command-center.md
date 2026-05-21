# LinkedIn command center

Route: [/platforms/linkedin](../../src/app/(app)/platforms/linkedin/page.tsx)

## Strategy

B2B trust layer. LinkedIn rewards depth and polish. Posts have higher polish, longer narrative, and lower tolerance for noisy promotion. Comments on industry posts count as first-class presence. Featured content is reserved for one founder essay, not a product link.

- **Voice:** professional, credible, restrained, B2B-grade.
- **Suggested cadence:** 3 posts per week (comments daily are encouraged).
- **Maximum cadence:** 5 posts per week.
- **Cooldown:** 24 hours between posts per account.
- **Link tolerance:** medium. One promotional post per account per week.

## What you see on the page

- **Polish checklist** — four pass/fail checks:
  1. Has at least one long-form item this week
  2. Promotional rhythm under one per account
  3. No high-risk or blocked items
  4. Comments on industry posts planned
- **Live recommendations** — pulled from the recommendations engine: missing long-form, excessive promotion, open high-risk items, backlog availability.
- **Accounts** — LinkedIn accounts with eligibility and readiness.
- **Content queue** — LinkedIn items in the weekly plan, ordered by time, with risk chips.
- **Risk rules** — LinkedIn-specific signals:
  - Weak credibility
  - Too casual tone
  - Too salesy
  - Overposting
  - Unsupported claims
  - Fake authority
  - Excessive product promotion
- **Playbook (10 modules)**:
  1. Authority posts (live)
  2. Founder narrative (passive)
  3. Professional trust layer (live)
  4. Company updates (live)
  5. Case study drafts (live)
  6. Comment strategy (passive)
  7. Profile credibility (live)
  8. Featured link (placeholder for LinkedIn API)
  9. B2B positioning (passive)
  10. Polish requirements (live)
- **Opportunities** — founder essay seeds and case study skeletons derived from product profiles.
- **Content formats** — founder_post, professional_insight, company_update, case_study, thoughtful_comment, product_lesson.
- **Analytics placeholder** — "Data not yet connected".
- **OAuth card** — explicit "not yet enabled".

## What this command center never does

- Pretend authority. Posts that read like generic "lessons from leadership" are flagged.
- Suggest CTA-heavy phrasing.
- Promote the same product more than once a week per account.
- Auto-feature a product page (the featured slot stays a placeholder until the API is live, and even then favors a founder essay).
