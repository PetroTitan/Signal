# Email / password auth

Phase C ships email + password auth. No social logins, no magic links, no MFA, no SSO. Minimal, mobile-friendly, calm.

## Routes

| Route | Purpose |
| --- | --- |
| `/login` | Sign-in form. Accepts a `?next=...` query for post-login redirect. |
| `/signup` | Sign-up form. Creates the auth user and (when the session is immediately available) the default workspace. |
| `/auth/callback` | Exchanges Supabase confirmation / OAuth-style `code` query params for a session and redirects. |
| `signOutAction` | Server action triggered from the sidebar form. Signs the user out and revalidates the app shell. |

## Server actions

All auth flows go through server actions in `src/app/(auth)/_actions.ts`:

- `signInAction(prevState, formData)` — calls `supabase.auth.signInWithPassword`. Redirects to `next` (or `/dashboard`) on success. Returns a friendly error string on failure.
- `signUpAction(prevState, formData)` — calls `supabase.auth.signUp`. If a session is returned (email confirmation off), creates the default workspace + initial activity event, then redirects to `/dashboard`. If no session (confirmation on), returns an inline "check your email" message.
- `signOutAction()` — calls `supabase.auth.signOut`, revalidates the layout, redirects to `/login`.

The signup path also bootstraps the workspace member row + the workspace_settings row inside `createWorkspace()` so RLS-safe ownership is established atomically.

## Session lifecycle

`src/middleware.ts` runs `updateSession()` from `@/lib/supabase/middleware` on every non-static request. That helper:

1. Reads cookies into a server Supabase client.
2. Calls `supabase.auth.getUser()` to refresh the session if needed.
3. Writes updated cookies onto the response.
4. Redirects unauthenticated users away from non-public paths.
5. Redirects authenticated users away from `/login` and `/signup`.

Public paths: `/`, `/about`, `/philosophy`, `/security`, `/how-it-works`, `/login`, `/signup`, anything under `/auth/`.

If Supabase env is not configured the middleware is a no-op — useful for local development without env vars and for documentation builds.

## What auth never asks for

- Platform passwords.
- Platform cookies.
- Platform session tokens.
- 2FA codes.
- Recovery codes.
- Browser fingerprints.

These have no UI surface and no storage column. The OAuth-first principle from earlier phases stays intact.

## Future

- Email verification flow (Supabase handles it; we already have the callback route).
- Password reset (route + email template).
- Optional social logins when there is a justified UX reason.

## See also

- [../database/supabase-auth-foundation.md](../database/supabase-auth-foundation.md)
- [../security/rls-phase-c.md](../security/rls-phase-c.md)
