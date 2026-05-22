/**
 * Shared result contract for server actions invoked via `useFormState`.
 *
 * Server actions wired into a same-route form **must** return this shape
 * in every code path — never `undefined`, never `void` via a thrown
 * redirect to the same route.
 *
 * For genuine cross-route navigation (e.g. `/login` → `/dashboard` after
 * sign-in), throwing `redirect()` is still the right pattern. The
 * concern is specifically same-route form submissions that re-mount the
 * caller component — in that case React 18's `useFormState` can settle
 * on `undefined` while the navigation resolves, and any `state.error`
 * read in the form crashes the page.
 */
export type ActionOk<TOk extends object> = { ok: true; error: null } & TOk;
export type ActionFail = { ok: false; error: string };
export type ActionResult<TOk extends object = Record<string, never>> =
  | ActionOk<TOk>
  | ActionFail;

export function actionOk<T extends object>(payload: T): ActionOk<T>;
export function actionOk(): ActionOk<Record<string, never>>;
export function actionOk<T extends object>(payload?: T): ActionOk<T> {
  return { ok: true, error: null, ...(payload ?? ({} as T)) };
}

export function actionFail(error: string): ActionFail {
  return { ok: false, error };
}
