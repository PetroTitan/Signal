# Follow Campaigns — manual QA checklist

Split by risk. **Everything in Part B performs real, public,
irreversible follows from a real account.** Part A does not.

Requires: the migration applied, a signed-in Bluesky identity,
`CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and `TOKEN_ENCRYPTION_KEY`
configured.

---

## Part A — read-only and non-mutating

Nothing here sends a write to Bluesky.

### Configuration
- [ ] Create a campaign: name, identity, each of the ten quotas,
      timezone, window, start date all persist.
- [ ] A quota outside the six options is rejected.
- [ ] An unknown timezone is rejected.
- [ ] A window ending before it starts is rejected.
- [ ] A campaign cannot be created against a non-Bluesky identity.
- [ ] Activation is refused while the identity is disconnected.

### Queue
- [ ] Import from candidates adds profiles; the count is exact.
- [ ] Re-importing the same source adds 0 and reports the duplicates.
- [ ] A protected candidate never enters the queue.
- [ ] The queue pager reaches the last page of a large campaign.
- [ ] Member rows show DID, handle, status and import sequence.

### Display
- [ ] Requested and effective quotas are **both** shown, never merged.
- [ ] When effective < requested, the reason is stated.
- [ ] Progress % is derived from completed members, not attempts.
- [ ] With no finished run, the completion estimate says so rather than
      showing a date.
- [ ] A handle stored with a leading `@` renders with exactly one.

### Safety controls (no provider writes)
- [ ] Pause on an active campaign → status `paused`, `next_run_at`
      cleared, queue counts unchanged.
- [ ] Resume → status `active`, same queue, same progress.
- [ ] Cancel → status `cancelled`; copy states nothing is unfollowed.
- [ ] Workspace kill switch → banner appears; release clears it.
- [ ] Per-identity kill switch → engages and releases.
- [ ] `BLUESKY_CAMPAIGNS_DISABLED=1` → the tick returns
      `{"ok":true,"disabled":true}`.

### Scheduler
- [ ] `curl` the tick with no header → **503** if unconfigured, **401**
      if the secret is wrong.
- [ ] With a valid secret and nothing due → `campaignsConsidered: 0`.
- [ ] Calling the tick five times in a row creates **one** run row for
      the day.

### Dry run *(recommended before any Part B step)*
- [ ] Create a campaign with **Dry run** ticked, queue real profiles,
      activate, and let a tick run.
- [ ] **Zero** follows appear on the Bluesky account.
- [ ] Members become `skipped`, never `succeeded`.
- [ ] `bluesky_identity_daily_usage.follows_created` stays 0.

### Layout
- [ ] 320 / 360 / 375 / 390 / 430 / 768 / 1280 px: no page-level
      horizontal scrolling on the campaign list, detail, queue, runs or
      create form.

### Regression — existing manual workflows
- [ ] Manual Follow and Unfollow still work from `/relationships`.
- [ ] The confirmation dialog still blocks first-click execution.
- [ ] **After a batch completes the dialog shows a result with only a
      Close button — the confirm control is gone and the same batch
      cannot be submitted again.**

---

## Part B — MUTATING. Real follows happen.

**Do not run these without explicit authorization from the account
owner.** Each step follows real people who will see it.

Start with the smallest possible campaign.

- [ ] Queue **three** profiles you genuinely intend to follow.
- [ ] Set the quota to 100 but confirm only three are queued.
- [ ] Activate. Wait for a tick inside the window.
- [ ] Exactly three follows appear on the Bluesky account — no more.
- [ ] Each member shows `succeeded` with a stored AT-URI, rkey and CID.
- [ ] `bluesky_relationship_actions` has one row per member, linked to
      the campaign and run.
- [ ] The run shows `attempted 3 / succeeded 3`.
- [ ] The identity's daily usage increased by exactly 3.
- [ ] The campaign becomes `completed`, once.
- [ ] A later tick does **not** re-follow anyone.

### Already-following
- [ ] Queue a profile the account already follows.
- [ ] It records `already_following`, creates **no** new record, and
      consumes **no** quota.

### Interruption
- [ ] Mid-run, pause. No further follows occur.
- [ ] Resume. It continues from where it stopped — no member is
      followed twice.

### Not to be simulated
Do **not** manufacture a 401 or a 429 against production to test the
failure paths. Those are covered by the automated suite against a fake
provider. Forcing them here would mean deliberately damaging a real
session or deliberately tripping a real rate limit on a real account.
