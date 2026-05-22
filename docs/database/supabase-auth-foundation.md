# Supabase + auth foundation

Phase C turns Signal from a deterministic frontend shell into a stateful SaaS foundation. This document captures the shape of that foundation and the boundaries it preserves.

## What Phase C shipped

- `@supabase/supabase-js` + `@supabase/ssr` installed.
- Public-only env contract (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`). No service-role key is read at runtime.
- Browser + server Supabase clients with strict cookie-aware patterns.
- Edge middleware that refreshes sessions and gates protected routes.
- Email / password auth with `/login`, `/signup`, `/auth/callback`.
- Repository layer (`src/repositories/`) for every Phase C entity.
- Default workspace creation on signup or first authenticated load.
- Server actions for product, account, and workspace-settings persistence.
- Real workspace activity feed at `/activity`.
- Demo mode (`NEXT_PUBLIC_SIGNAL_DEMO_MODE`) preserved.

## What Phase C did **not** ship

- No OpenAI runtime. `MockAiProvider` still powers any AI use case.
- No Reddit / X / LinkedIn OAuth. `connection_status` stays `not_connected`.
- No publishing. No background jobs. No cron.
- No Stripe. No billing. No edge functions.
- No service-role-key path. No client-side secret handling.
- No WebmasterID analytics ingestion.

## File layout

```
src/lib/supabase/
  env.ts           # readSupabaseEnv / requireSupabaseEnv / isSupabaseConfigured
  browser.ts       # getSupabaseBrowserClient
  server.ts        # createSupabaseServerClient (cookies-aware)
  middleware.ts    # updateSession() — used by src/middleware.ts
  types.ts         # Row / Insert / Update + Database

src/repositories/
  errors.ts                  # RepositoryError + helpers
  workspace-repository.ts    # listMyWorkspaces, createWorkspace, ...
  product-repository.ts      # listProducts, createProduct, updateProduct
  account-repository.ts      # listAccounts, createAccount, updateAccount
  settings-repository.ts     # getSettings, updateSettings
  activity-repository.ts     # listRecentActivity, recordActivity

src/core/workspace-session/
  context.tsx                # WorkspaceSessionProvider / useWorkspaceSession

src/middleware.ts            # exports the edge middleware

supabase/migrations/
  20260522000001_phase_c_schema.sql
  20260522000002_phase_c_rls.sql
```

## Where Supabase is touched

Only repositories and middleware. UI components never import the Supabase client. Server actions call repositories. Server components call repositories. This boundary preserves the determinism of the existing engines and lets the next persistence migration (e.g. weekly plans, items) slot in without changing pages.

## What this unlocks

- Persistent workspaces, products, accounts, and settings per user.
- Sign-in + sign-out across devices.
- Activity feed that reflects what happened in the workspace.
- A clean place to wire AI + OAuth + Stripe in subsequent phases.

## See also

- [./phase-c-migrations.md](./phase-c-migrations.md)
- [./repository-layer.md](./repository-layer.md)
- [./real-empty-state.md](./real-empty-state.md)
- [../auth/email-password-auth.md](../auth/email-password-auth.md)
- [../security/rls-phase-c.md](../security/rls-phase-c.md)
