# Repository layer

Phase C introduces a small repository layer under `src/repositories/`. UI components do not call Supabase directly. They go through repositories, which return typed domain objects and translate Postgres errors into a single `RepositoryError` type.

## Files

| File | Responsibility |
| --- | --- |
| `errors.ts` | `RepositoryError` class with discriminated codes (`not_configured`, `not_authenticated`, `not_found`, `constraint`, `unknown`). |
| `workspace-repository.ts` | `listMyWorkspaces`, `getPrimaryWorkspace`, `createWorkspace`, `renameWorkspace`, `getWorkspaceById`. |
| `product-repository.ts` | `listProducts`, `getProductById`, `createProduct`, `updateProduct`. |
| `account-repository.ts` | `listAccounts`, `getAccountById`, `createAccount`, `updateAccount`. |
| `settings-repository.ts` | `getSettings`, `updateSettings`. |
| `activity-repository.ts` | `listRecentActivity`, `recordActivity`. |
| `index.ts` | Barrel re-export. |

Every repository file starts with `import "server-only"` so they cannot accidentally be bundled into a client component.

## Domain mapping

The Supabase types live in `src/lib/supabase/types.ts` (`WorkspaceRow`, `ProductInsert`, etc.). The repository layer maps those rows to friendlier domain shapes:

- snake_case columns → camelCase fields.
- `created_at` / `updated_at` stay as ISO strings.
- Nullable columns stay nullable.

This means application code (server components, server actions) sees `workspace.createdAt` not `row.created_at`. The DB shape is encapsulated.

## Error handling

Repository functions throw `RepositoryError` with one of:

- `not_configured` — Supabase env is missing.
- `not_authenticated` — no user on the session.
- `not_found` — `.maybeSingle()` returned null.
- `constraint` — Postgres returned a 23xxx code.
- `unknown` — any other Postgres error.

Server actions catch the error, format a user-visible message, and return it via the action's result type. No raw Postgres error leaks to the UI.

## Auth pattern

Most write functions call `supabase.auth.getUser()` first and throw `notAuthenticated()` if the user is missing. This is belt-and-braces — RLS would block the operation anyway — but it gives a clean error path instead of relying on a Postgres permission failure.

## Why no Database generic

The supabase-js `GenericSchema` constraint requires Row/Insert/Update types to extend `Record<string, unknown>`, which TypeScript's `interface` declarations don't satisfy structurally. We deliberately do not pass the Database generic to `createServerClient` / `createBrowserClient`. Instead, the repositories cast Supabase responses to the strongly-typed row shapes from `types.ts`. Runtime safety still comes from Postgres + RLS; static safety still holds at the repository boundary.

This is a self-imposed boundary and can be tightened later when we generate Database types via `supabase gen types`.

## What repositories do not do

- They do not orchestrate cross-table workflows beyond the workspace bootstrap. Multi-step flows live in server actions.
- They do not enforce business rules — that lives in `src/core/*` engines that read domain objects.
- They do not cache. Caching belongs in the route / page layer, not the data layer.

## See also

- [./supabase-auth-foundation.md](./supabase-auth-foundation.md)
- [./real-empty-state.md](./real-empty-state.md)
- [./mock-to-db-transition.md](./mock-to-db-transition.md)
