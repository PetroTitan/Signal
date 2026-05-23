# Live platform verification — F5.1

This document is the **honest record** of which platform publish flows have
been verified end-to-end against real services, vs which exist only as
typecheck-clean code. It is updated whenever a real publish lands and the
resulting `publish_history` row is observed.

**Format:** one section per platform with the same fields:

- **Verified?** — yes / no / partial
- **What worked** — observed behavior in production
- **What failed** — observed errors, edge cases, or regressions
- **What still unverified** — paths the code supports but no human has
  run live
- **Known UX friction** — papercuts a daily founder hits
- **Known legal / platform risk** — TOS, automation-detection, API
  approval status
- **Recommended next action** — the one thing that would close the
  biggest verification gap

Sections marked *(F5.1 — not yet verified live)* mean the code was
written but no live request has reached the platform from this
environment. F5.1 was authored without API credentials or outbound
network access to these services.

---

## dev.to

- **Verified?** No.
- **What worked:** Typecheck, lint, production build. The HTTP shape matches
  the documented Forem v1 article-create endpoint (`POST /api/articles`
  with `api-key` header). Response parser handles the article id, slug,
  canonical URL, and `published_at` correctly per the docs.
- **What failed:** N/A — no live calls performed.
- **What still unverified:**
  - That `DEVTO_API_KEY` actually authenticates against the live API
  - The exact rate-limit ceiling (docs say 5 articles / 60 seconds; not observed)
  - That the response `url` field returns the canonical permalink shape
    the duplicate-protection partial index expects
  - The 422 validation error shape (we parse `{ error: "..." }` per docs)
- **Known UX friction:** None observed; the `PublishTierOneForm` is calm
  and single-confirm.
- **Known legal / platform risk:** Low. dev.to publishes are first-party
  via the official Forem API.
- **Recommended next action:** Drop a real `DEVTO_API_KEY` into Vercel env,
  click "Publish to dev.to" on one approved draft, observe the
  `publish_history` row and the URL.

## Hashnode

- **Verified?** No.
- **What worked:** Typecheck, lint, build. GraphQL `publishPost` mutation
  shape is verified against the published Hashnode API docs.
- **What failed:** N/A — no live calls performed.
- **What still unverified:**
  - That `HASHNODE_API_KEY` authenticates (note: Hashnode expects the raw
    token in `Authorization`, NOT `Bearer <token>` — easy to get wrong)
  - That `HASHNODE_PUBLICATION_ID` resolves to a publication the key
    can write to
  - The exact error shape when tags reference non-existent publication tags
  - That `originalArticleURL` is the correct field name (Hashnode has had
    casing variants in past schema versions)
- **Known UX friction:** None observed.
- **Known legal / platform risk:** Low.
- **Recommended next action:** Same as dev.to — drop a key, publish once,
  capture the response.

## Bluesky

- **Verified?** No.
- **What worked:** Typecheck, lint, build. AT Protocol shape matches the
  documented `com.atproto.server.createSession` and
  `com.atproto.repo.createRecord` endpoints. Thread splitter is
  unit-testable (pure function). Facet builder produces correctly
  byte-range-shaped facet objects per docs.
- **What failed:** N/A — no live calls performed.
- **What still unverified:**
  - That `BLUESKY_IDENTIFIER` + `BLUESKY_APP_PASSWORD` produce a
    successful `createSession` response
  - That the permalink-synthesis path (`at://<did>/...` →
    `https://bsky.app/profile/<handle>/post/<rkey>`) produces a working
    URL
  - That facet byte ranges are accepted by Bluesky's validator for
    complex emoji / RTL text
  - That thread reply refs (`reply.root.uri` / `reply.parent.uri`)
    correctly thread on the live network
- **Known UX friction:** None observed.
- **Known legal / platform risk:** Low — first-party AT Protocol.
- **Recommended next action:** Drop credentials, publish a short post +
  a 3-part thread, capture both permalinks.

## X (Twitter)

- **Verified?** No.
- **What worked:** Typecheck, lint, build. Transformer correctly splits
  long bodies into ≤260-char parts, strips hashtags, preserves only the
  first URL.
- **What failed:** N/A — no live actions performed.
- **What still unverified:**
  - Whether `https://x.com/intent/post?text=...` redirects correctly to
    the composer when the user is logged in
  - Whether `https://x.com/intent/post` URL still works (it has changed
    twice in the past 2 years across the X.com rebrand)
  - The current permalink format (`x.com/<handle>/status/<id>` vs
    legacy `twitter.com/<handle>/status/<id>`) — the validator accepts both
  - Mobile-app fallback (the intent URL may try to open the X app on
    iOS and lose context)
- **Known UX friction:** Founder must manually post each subsequent
  thread part as a reply — X's intent URL only pre-fills the first post.
- **Known legal / platform risk:** Very low. Signal does NOT use the X
  API, does NOT scrape, does NOT automate the browser. The founder
  publishes by hand.
- **Recommended next action:** Open `/execution/items/<id>` for an X draft
  in a real browser, click "Open X composer", confirm the composer opens
  with the first post pre-filled.

## LinkedIn

- **Verified?** No.
- **What worked:** Typecheck, lint, build. Transformer strips markdown,
  enforces 3000-char hard limit, warns when word count exceeds 1200.
- **What failed:** N/A.
- **What still unverified:**
  - Whether `https://www.linkedin.com/sharing/share-offsite/?url=...`
    actually opens the share dialog (LinkedIn has changed this URL
    multiple times)
  - Whether the body must be pasted manually (current assumption — yes;
    LinkedIn's share URL only accepts a `url` parameter)
  - The exact permalink format LinkedIn returns (`/posts/<urn>` vs
    `/feed/update/urn:...` — the validator accepts any linkedin.com URL)
- **Known UX friction:** Body is always pasted manually. No way around
  this until LinkedIn ships a body-prefill API parameter (they haven't
  in 10+ years).
- **Known legal / platform risk:** Very low — manual posting only.
- **Recommended next action:** Same as X — confirm the share intent
  URL opens the composer, paste the body, post, capture permalink.

## YouTube *(F5.1 — not yet verified live)*

- **Verified?** No.
- **What worked:** Code-only. Transformer produces title (≤100 chars),
  description (plain text, paragraph breaks), 12 tags max, chapter
  timestamps, a single shorts hook line, and a textual thumbnail idea.
- **What failed:** N/A.
- **What still unverified:**
  - That the YouTube Studio link (`https://studio.youtube.com/`) is the
    right starting URL for upload (no intent URL exists for video upload)
  - That permalink recording accepts both `youtube.com/watch?v=...` and
    `youtu.be/...` shapes
- **Known UX friction:** YouTube has NO public way to pre-fill upload
  metadata via URL. The founder must paste each field (title, description,
  tags) one at a time. Signal provides Copy buttons for each.
- **Known legal / platform risk:** None — Signal does not upload video.
- **Recommended next action:** Once a real YouTube identity exists,
  walk through a real upload using Signal's Copy buttons, capture the
  permalink, confirm `publish_history` records `platform='youtube'`.

## Threads *(F5.1 — not yet verified live)*

- **Verified?** No.
- **What worked:** Code-only. Transformer enforces 400-char soft / 500-char
  hard limit (Threads' actual hard limit is 500), strips markdown and
  hashtags.
- **What failed:** N/A.
- **What still unverified:**
  - That Threads has a stable `intent`-style URL for composing (Meta has
    not documented one; we route the founder to threads.net for manual
    composition)
  - The exact permalink format Threads returns
- **Known UX friction:** Body pasted manually (no documented intent URL).
- **Known legal / platform risk:** Very low — Signal does not touch Meta APIs.
- **Recommended next action:** Confirm threads.net composer opens, post,
  capture permalink, record.

## Instagram *(F5.1 — not yet verified live)*

- **Verified?** No.
- **What worked:** Code-only. Transformer produces caption (1200/2200 char
  limits), 5-slide carousel outline (text only), reel caption + hook,
  hashtags filtered against the `#fyp / #viral / #grindset` ban list.
- **What failed:** N/A.
- **What still unverified:**
  - That instagram.com's compose URL still works for desktop founders
    (Instagram is mobile-first; desktop composer was added recently)
  - That the carousel outline is genuinely useful for non-text post types
- **Known UX friction:** Instagram is a fundamentally mobile platform.
  Founder posts on the iOS/Android app, then pastes the permalink back
  into Signal on desktop. Round trip is awkward.
- **Known legal / platform risk:** Very low — manual posting only.
- **Recommended next action:** Test on mobile; confirm `instagram.com/p/<id>/`
  permalink shape parses cleanly.

## Telegram *(F5.1 — semi-automated, not yet verified live)*

- **Verified?** No.
- **What worked:** Code-only. `publish-telegram.ts` calls
  `https://api.telegram.org/bot<TOKEN>/sendMessage` per the documented
  Bot API shape, with `disable_web_page_preview=false` and
  `disable_notification=true` defaults. Permalink synthesizer maps
  `@channelname` + `message_id` to `https://t.me/<channel>/<id>`.
- **What failed:** N/A.
- **What still unverified:**
  - That a real `TELEGRAM_BOT_TOKEN` authenticates
  - That the Bot has been added as admin to the target channel by the
    founder (precondition for `sendMessage`)
  - That permalink synthesis works for private channels (they don't
    have a `t.me/<channel>` URL)
  - The exact 400-error shape when the bot is NOT a channel admin
- **Known UX friction:** Founder must manually add the Signal bot as an
  admin to their channel before the first publish. No way around this —
  Bot API requires admin rights to post.
- **Known legal / platform risk:** Low. Telegram Bot API is first-party
  and explicitly designed for this use case. The brief's "no scraping,
  no joining groups, no DM automation" constraints are honored: Signal
  only calls `sendMessage` to a single channel the founder explicitly
  configured.
- **Recommended next action:** Create a Telegram bot via @BotFather, drop
  the token in env, add the bot to a test channel as admin, publish one
  post, observe the message id + permalink.

## Reddit

- **Verified?** Partial.
- **What worked (prior phases):** F2.6 manual fallback flow is documented
  in the F2.6 brief and was used during development. The manual
  copy-paste + permalink-record path is the same shape used by F5.0
  for X/LinkedIn, so the underlying `publish_history` shape is known
  to work.
- **What failed:** Reddit OAuth app provisioning is **still blocked** by
  Reddit's Responsible Builder Policy review. `REDDIT_OAUTH_STATUS=blocked_pending_reddit_api_approval`
  has been set on the workspace since F2.5. The manual fallback covers
  the gap.
- **What still unverified:** Whether the Reddit API path (via `publish-reddit.ts`)
  works end-to-end against a real account once OAuth approval lands.
- **Known UX friction:** Manual fallback is functional but slower than
  the API path would be.
- **Known legal / platform risk:** Reddit holds the keys here. No
  automation runs without their approval.
- **Recommended next action:** Resubmit the OAuth app to Reddit and
  document the response.

---

## Summary

**Zero platforms have been verified end-to-end live in this environment.**
All publish paths are typecheck-clean, lint-clean, and build-clean. The
verification work that needs to happen — credentials + clicks against real
services — must be done by an operator with API keys and outbound network
access. This document is updated whenever that happens.

If you've performed a live verification and want to update this file:

1. Set **Verified** to "yes" or "partial".
2. Add a dated note under **What worked** with the exact permalink
   captured.
3. Add anything that surprised you under **What still unverified** so
   the next person knows what to look for.

This file is the truth source for "does X actually work?". Treat it as
the canonical answer.
