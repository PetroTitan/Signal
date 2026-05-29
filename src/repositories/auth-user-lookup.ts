import "server-only";

/**
 * Phase F10 — service-role auth.users lookup.
 *
 * The /settings/team add flow needs to resolve an email to a stable
 * `auth.users.id` before inserting a `workspace_members` row. The
 * `auth` schema is not exposed via PostgREST, so we use the
 * Supabase Admin API (via the service-role client) — the same
 * channel the team-invite flow will graduate to in a future PR.
 *
 * Hard scope
 * ----------
 *   - Only ever returns `{ id, email }` for matched users. NEVER
 *     returns encrypted_password, email_confirmed_at, raw_meta,
 *     tokens, or any other auth-sensitive field.
 *   - Returns null on service-role unavailable, network error, or
 *     no match — the caller surfaces "User must first sign up" UX
 *     so no behavior depends on the failure being a particular
 *     shape.
 *   - Pagination is capped (200 users / 4 pages) because Signal's
 *     team page is for small workspaces. A larger user base would
 *     warrant a dedicated SECURITY DEFINER RPC `find_user_by_email`;
 *     not needed for v1.
 */

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service-role";

export interface AuthUserLookup {
  id: string;
  email: string | null;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Look up a single auth.users row by email.
 *
 * Resolution path: page through `auth.admin.listUsers` and match on
 * the (lowercased, trimmed) email. The Admin API does not yet
 * surface a server-side `email=` filter so we paginate client-side.
 *
 * Returns:
 *   - `{ id, email }` when a user matches.
 *   - `null` when no user matches, the email is empty, the
 *     service-role client is not configured, or the admin call
 *     errors. The /settings/team server action surfaces a single
 *     "User must first create a Signal account" message in all of
 *     these cases — Signal does not leak whether a particular
 *     email is registered to an unauthorized caller.
 */
export async function findAuthUserIdByEmail(
  email: string,
): Promise<AuthUserLookup | null> {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0) return null;

  const serviceRole = createSupabaseServiceRoleClient();
  if (!serviceRole) return null;

  // Page through up to 200 users (50 × 4 pages). For most Signal
  // workspaces this is many multiples of the actual auth.users size;
  // we exit early when a page returns fewer than the per-page cap.
  for (let page = 1; page <= 4; page += 1) {
    const { data, error } = await serviceRole.auth.admin.listUsers({
      page,
      perPage: 50,
    });
    if (error) return null;
    if (!data?.users || data.users.length === 0) return null;
    for (const u of data.users) {
      if (typeof u.email === "string" && normalizeEmail(u.email) === normalized) {
        return { id: u.id, email: u.email };
      }
    }
    if (data.users.length < 50) return null;
  }
  return null;
}

/**
 * Bulk email lookup keyed by `auth.users.id`. Used by the
 * /settings/team page to enrich the member list with display emails.
 *
 * Returns an empty map when the service-role client is unavailable
 * — the page falls back to showing user-id stubs rather than
 * crashing. Callers must tolerate missing entries.
 */
export async function listAuthUserEmails(
  userIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (userIds.length === 0) return out;
  const serviceRole = createSupabaseServiceRoleClient();
  if (!serviceRole) return out;
  const wanted = new Set(userIds);
  for (let page = 1; page <= 4 && wanted.size > 0; page += 1) {
    const { data, error } = await serviceRole.auth.admin.listUsers({
      page,
      perPage: 50,
    });
    if (error) return out;
    if (!data?.users || data.users.length === 0) return out;
    for (const u of data.users) {
      if (wanted.has(u.id) && typeof u.email === "string" && u.email.length > 0) {
        out.set(u.id, u.email);
        wanted.delete(u.id);
      }
    }
    if (data.users.length < 50) return out;
  }
  return out;
}
