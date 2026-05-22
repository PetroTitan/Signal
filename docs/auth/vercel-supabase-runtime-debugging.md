# Vercel + Supabase runtime debugging

If the `/login` or `/signup` page renders an amber "Authentication is not available" notice on Vercel, the Supabase env is not loaded the way Signal expects. This doc walks through diagnosing it without ever exposing the anon-key value.

The companion doc [supabase-env-troubleshooting.md](./supabase-env-troubleshooting.md) covers the validation rules themselves. Read that first.

## Required env on Vercel

```
NEXT_PUBLIC_SUPABASE_URL=https://kcaxqzbnrxzqisewbdkf.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<the publishable key from Project Settings → API>
NEXT_PUBLIC_SIGNAL_DEMO_MODE=false
```

Set these for **Production**, **Preview**, and **Development** in Vercel → Settings → Environment Variables. Save, then **redeploy the target environment** (env changes do not apply to existing builds).

## The two-pane diagnostic

Two surfaces report the runtime env state, both safe to share publicly:

### 1. The amber notice on `/login` and `/signup`

When validation fails, the notice renders a compact diagnostic table. Each row is safe to screenshot:

- `protocol`, `hostname`, `pathname` — what the URL parsed to.
- `query`, `fragment` — present / absent only.
- `url length` — number of characters in the trimmed env value.
- `anon key` — shape (`looks_like_jwt`, `looks_like_publishable`, `looks_like_url`, `unknown`, `missing`) and length only. **Never the value.**
- `normalized` — present when Signal had to strip surrounding quotes, whitespace, or a trailing slash from the env to attempt validation.

This is the fastest way to see what Vercel actually loaded.

### 2. The server log on first middleware hit

The middleware emits a single log line per process: `[supabase-env] middleware diagnostics { … }`. The payload is the same `SupabaseConfigDiagnostics` shape rendered above. Look in:

- Vercel Dashboard → your project → **Logs** (Runtime tab) for production.
- Vercel CLI: `vercel logs <deployment-url>`.

The log fires once per cold start. If you trigger a redeploy, the next request will log fresh diagnostics.

## Mapping diagnostics to fixes

| Diagnostic clue | Likely cause | Fix |
| --- | --- | --- |
| `urlPresent: false` | Env not set on this environment, or set on a different one. | Set `NEXT_PUBLIC_SUPABASE_URL` on the correct environment. **Redeploy.** |
| `urlParses: false` | Quotes survived into the value, or there are stray characters. | Repaste the URL without surrounding quotes. The new normalizer strips them, but the rule of thumb is "no quotes". |
| `urlIsHttps: false` | `http://` pasted. | Change to `https://`. |
| `urlHostnameLooksLikeSupabase: false` | Dashboard URL (`https://supabase.com/…`) pasted, or a custom domain. | Use the **Project URL** from Supabase Dashboard → Project Settings → API. |
| `urlHasNoPath: false` (or `pathname` shows `/auth/v1` / `/rest/v1` / `/dashboard/…`) | A Supabase or dashboard endpoint URL pasted. | Strip everything after `<ref>.supabase.co`. The base URL has no path. |
| `urlHasSearch: true` or `urlHasHash: true` | Copy-pasted from a URL with a query string. | Strip everything from `?` or `#` onward. |
| `anonKeyShape: missing` | Env not set. | Set `NEXT_PUBLIC_SUPABASE_ANON_KEY`. **Redeploy.** |
| `anonKeyShape: looks_like_url` | URL pasted into the anon-key slot. | The two env values are swapped. Fix in Vercel. |
| `anonKeyShape: unknown` | A literal template like `<publishable key>`, or a wrong key. | Paste the real publishable / anon key from Supabase Dashboard → Project Settings → API. |
| `urlNormalizationApplied: true` | Value had stray whitespace / quotes / trailing slash. The normalizer fixed them, but the underlying paste is sloppy. | Repaste cleanly to avoid future surprises. |

## Vercel-specific gotchas

1. **Env changes need a redeploy.** Setting an env var in Vercel does not retroactively apply it to the live deployment. Trigger a redeploy (Vercel UI → Deployments → ⋯ → Redeploy, or push a new commit).
2. **Per-environment values.** Vercel stores env vars per environment (Production / Preview / Development). A value set only for Preview won't be present in Production.
3. **Promote vs Deploy.** If you promote an older deployment to Production, it uses the env vars baked into that deployment's build, not the current env vars in settings.
4. **Edge runtime is fine for our middleware.** `process.env.NEXT_PUBLIC_*` is replaced at build time and available at edge runtime — we do not read any non-public env in middleware.
5. **No private overrides.** `SUPABASE_SERVICE_ROLE_KEY` is **never** read by this app. Do not set it; if it is set, ignore it. The amber notice and the server logs reference only `NEXT_PUBLIC_*` variables.

## What the normalizer fixes automatically

The env reader applies these transforms before validation. They are documented so you know what's safe to paste:

- Strips invisible characters (ZWSP, ZWNJ, ZWJ, BOM, NBSP) anywhere in the value.
- Trims Unicode whitespace from both ends.
- Strips a single pair of surrounding quotes (`"`, `'`, or backtick).
- Strips any number of trailing slashes from the URL before parsing.

Anything else is rejected with a specific reason. The normalizer is not a workaround for bad data — it just absorbs the most common copy-paste accidents so the diagnostic is about the real issue, not punctuation.

## What the normalizer will not fix

- Path components like `/auth/v1` or `/dashboard/project/<ref>`. The URL must be the project base.
- Hostname not ending with `.supabase.co`.
- Wrong env name (e.g. `SUPABASE_URL` without the `NEXT_PUBLIC_` prefix).
- Swapped URL and anon key.
- A literal template string (`<project-ref>`, `<publishable key>`).

## Verification flow

After fixing env on Vercel and redeploying:

1. Open `<deployment-url>/login` in incognito.
2. The amber notice should be **gone**. If it persists, read the new diagnostic table — the cause will be different now.
3. Submit signup credentials. You should be redirected to `/dashboard`.
4. Open `<deployment-url>/dashboard` in a fresh incognito window. You should be redirected to `/login`.

If steps 1–3 work and step 4 does not, the issue is not env — it's route protection. See [supabase-env-troubleshooting.md](./supabase-env-troubleshooting.md#fail-closed-route-protection).

## Hard rule

We never weaken validation to make a broken env "work". If a deployment hits the notice, the right answer is to fix the env, not the validator.
