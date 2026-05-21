# Roadmap

Signal is being built in phases. Each phase preserves the previous one — no rewrites, no rip-and-replace.

## Phase 0 — MVP foundation (current)

- Application shell, navigation, and visual system.
- Domain models.
- Mock data for one workspace, six products, eight accounts, one weekly plan.
- Dashboard, products, accounts, weekly plan, approval queue, scheduler, risk center, analytics, settings.
- Documentation.
- No third-party integrations.

## Phase 1 — persistence

- Replace `src/lib/mock` with a Supabase-backed data layer behind the same domain types.
- Workspace and user identity.
- Audit trail for approval events.

## Phase 2 — platform integrations

- OAuth handshake for Reddit, X, and LinkedIn.
- Adapter contract implemented per platform.
- Publishing path for approved scheduled posts.
- Engagement snapshot pull.

## Phase 3 — analytics

- WebmasterID client integration.
- Conversion stream from tracking links to platform/account attribution.
- Per-product performance views.

## Phase 4 — assist

- LLM-assisted draft generation (still gated by the weekly approval).
- Tone classifier feeding the risk engine.
- Account-fatigue scoring over multiple weeks.

## Phase 5 — collaboration

- Multi-user workspaces.
- Role-based approvals.
- Shared backlog and comment threads on plan items.

## Non-goals (forever)

- Mass automation.
- Anti-detect browsing.
- Proxy or fingerprint manipulation.
- Storing platform passwords.
