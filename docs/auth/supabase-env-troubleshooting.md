# Supabase env troubleshooting

If signup or sign-in fails with errors like:

- `Invalid path specified in request URL`
- `Failed to fetch`
- `Authentication is not available right now`

…the Supabase env on the deployment is misconfigured. This doc explains the exact values to set and how Signal validates them.

## Required env

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<publishable anon key>
NEXT_PUBLIC_SIGNAL_DEMO_MODE=false
```

Both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are public by design. They ship to the browser. The validation that Signal applies makes sure nothing else accidentally goes there.

## Where to find the values

Supabase Dashboard → **Project Settings** → **API**:

- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
- **Project API keys → Publishable key (or anon key)** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Do **not** copy the **secret key** / **service_role**. Service-role bypasses RLS and must never reach the browser.

## How Signal validates env

`src/lib/supabase/env.ts` runs these checks in order. The first failing check is the reported reason:

| Check | Failure message |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` present | "NEXT_PUBLIC_SUPABASE_URL is missing or empty." |
| URL parses (`new URL(...)`) | "NEXT_PUBLIC_SUPABASE_URL does not parse as a URL." |
| Protocol is `https:` | "NEXT_PUBLIC_SUPABASE_URL must use https://" |
| Hostname ends with `.supabase.co` | "NEXT_PUBLIC_SUPABASE_URL hostname must end with .supabase.co" |
| URL has no path / query / fragment | "NEXT_PUBLIC_SUPABASE_URL must be the project base URL with no path, query, or fragment." |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` present | "NEXT_PUBLIC_SUPABASE_ANON_KEY is missing or empty." |
| Anon key does not start with `https://` | "NEXT_PUBLIC_SUPABASE_ANON_KEY looks like a URL. Did you swap the URL and the anon key?" |
| Anon key shape is JWT (`eyJ…`) or publishable (`sb_publishable_…`) | "NEXT_PUBLIC_SUPABASE_ANON_KEY shape is unrecognized." |

The same diagnostic is rendered at the top of `/login` and `/signup` when any check fails — users see exactly which env var to fix.

## Common mistakes

1. **Dashboard URL pasted as the project URL.** The dashboard URL is `https://supabase.com/dashboard/project/<ref>`. That fails the "no path" check. The correct value is `https://<ref>.supabase.co`.
2. **Trailing slash on the URL.** `https://<ref>.supabase.co/` is **accepted** — Signal strips the trailing slash before passing it to the Supabase client.
3. **Secret key pasted instead of anon key.** The secret key starts with `sb_secret_`. Signal classifies that under `looks_like_publishable` but the connection will fail with a 401 — and you should not ship `sb_secret_` to the browser anyway. Use the publishable key (`sb_publishable_…`) or the legacy anon JWT.
4. **Swapped URL and anon key.** A common copy-paste mistake. The shape check on the anon key catches this — `looks_like_url`.
5. **Trailing whitespace or zero-width characters.** Signal trims whitespace. Zero-width characters survive trim and corrupt the URL; if you suspect this, retype the value rather than paste it.
6. **Set on the wrong Vercel environment.** Env vars are per-environment in Vercel (Production / Preview / Development). Set all three for Production at minimum.

## Verifying locally

Create `.env.local` (gitignored) with the values above and run:

```
npm run dev
```

Open `http://localhost:3000/signup`. If the form renders without an amber notice, env passed validation. Submit a test email and password — you should be redirected to `/dashboard` (or shown the email-confirmation message if email confirmation is on in Supabase).

## Verifying on Vercel preview

After setting the env vars in Vercel:

1. Redeploy the preview (env changes are not applied to existing builds).
2. Open `<preview-url>/signup`.
3. If the amber notice appears, the reason text describes the exact failing check.

## What about demo mode?

`NEXT_PUBLIC_SIGNAL_DEMO_MODE=true` does **not** mask a broken Supabase env on the auth pages, and it does **not** bypass authentication. `/login` and `/signup` always require valid Supabase env to function. Demo mode only affects which fixture data the React store renders **inside** the authenticated app shell — anonymous users never reach the app shell in any mode.

## Fail-closed route protection

The middleware and the `(app)` layout both fail closed:

- **Middleware (`src/middleware.ts` → `src/lib/supabase/middleware.ts`):** when env is missing or invalid, requests to any protected route are redirected to `/login?reason=auth_unavailable`. Public routes (`/`, `/about`, `/philosophy`, `/security`, `/how-it-works`, `/login`, `/signup`, `/auth/*`) still render — `/login` shows the amber config notice with the exact failing check.
- **`(app)/layout.tsx`:** if env is misconfigured at render time, the layout redirects to `/login?reason=auth_unavailable` before any DB call. If the user is anonymous, the layout redirects to `/login`. This is the backstop in case middleware somehow doesn't run for a route.
- **`supabase.auth.getUser()` failures** (network errors, expired tokens) are treated as anonymous — the user is sent to `/login`, never granted access to a protected route.

Anonymous access to any protected route is impossible under valid or invalid env.

## Security boundary

- The browser only ever receives the public URL and the anon / publishable key.
- The secret / service-role key has no environment variable in this repo and must not be added.
- `src/lib/supabase/env.ts` reads only `NEXT_PUBLIC_*` variables.
- Diagnostic logs never include the anon-key value — only `present` / `shape` / `reason`.

## See also

- [./email-password-auth.md](./email-password-auth.md)
- [../database/supabase-auth-foundation.md](../database/supabase-auth-foundation.md)
- [../security/rls-phase-c.md](../security/rls-phase-c.md)
