import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { logSupabaseEnvDiagnosticsOnce, readSupabaseEnv } from "./env";

/**
 * Routes that do not require an authenticated session.
 */
const PUBLIC_PATH_PREFIXES = [
  "/",
  "/about",
  "/philosophy",
  "/security",
  "/how-it-works",
  "/login",
  "/signup",
  "/forgot-password",
  "/auth",
  // Phase F0: external operators reach the MCP HTTP bridge via bearer
  // token, not a Supabase cookie. The route handler does its own
  // auth; the middleware must not redirect to /login.
  "/api/mcp",
  // Phase F1: scheduler tick is triggered by Vercel Cron / curl with a
  // shared secret. The route handler enforces the secret; the
  // middleware must not redirect to /login.
  "/api/scheduler",
  // Phase F9 — OAuth callback path. The OAuth handshake has its own
  // security model:
  //   - PKCE code_verifier persisted server-side at /start; the
  //     callback recovers it via the one-shot state token and sends
  //     it to the provider in the token exchange body.
  //   - `state` is a 32-byte cryptographically-random base64url
  //     token, bound at insertion to (workspace_id, user_id,
  //     platform), time-limited (10 minutes), and deleted on first
  //     read.
  // The middleware's session-cookie check is REDUNDANT against this
  // model and FRAGILE across the cross-site provider redirect (e.g.,
  // when a browser strips the SSR cookie during the X / Reddit
  // round-trip, the callback would otherwise be redirected to
  // /login?next=/api/oauth/x/callback and the OAuth flow would
  // silently fail — `oauth_state_tokens` rows pile up uncosumed and
  // `platform_connections` never gets a row). Adding `/api/oauth`
  // to the public set lets the OAuth route handler execute its own
  // state validation. The /start route (which DOES need an
  // authenticated session to bind state to user_id) is unaffected —
  // it's reached via in-app navigation while signed in, not from a
  // cross-site redirect.
  "/api/oauth",
];

const PUBLIC_EXACT_PATHS = new Set<string>([
  "/",
  "/about",
  "/philosophy",
  "/security",
  "/how-it-works",
  "/login",
  "/signup",
  // Anyone can request a recovery email; sending the email never reveals
  // whether the address is registered. /reset-password is intentionally
  // NOT public — the middleware's session check is what guarantees only
  // the user who clicked a valid recovery link can submit the form.
  "/forgot-password",
]);

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true;
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (prefix === "/") continue;
    if (pathname === prefix) return true;
    if (pathname.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/**
 * Edge middleware that refreshes the Supabase session cookie on every
 * request and gates protected app routes.
 *
 * Fail-closed: if the Supabase env is missing or invalid, protected
 * routes redirect to `/login`. Public marketing routes and `/login` /
 * `/signup` / `/auth/*` still render — `/login` is where the user
 * sees the config notice that explains what's misconfigured.
 */
export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  logSupabaseEnvDiagnosticsOnce("middleware");
  const env = readSupabaseEnv();

  if (!env) {
    if (isPublicPath(pathname)) {
      return NextResponse.next({ request });
    }
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.search = "";
    redirect.searchParams.set("reason", "auth_unavailable");
    redirect.searchParams.set("next", pathname);
    return NextResponse.redirect(redirect);
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"] = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
  } catch (err) {
    // If we can't even ask Supabase whether the user is authenticated,
    // treat them as anonymous and let the redirect logic below send
    // them to /login. We never let a network or auth failure expose a
    // protected route.
    console.error("[middleware] supabase.auth.getUser failed", err);
    user = null;
  }

  if (!user && !isPublicPath(pathname)) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.search = "";
    redirect.searchParams.set("next", pathname);
    return NextResponse.redirect(redirect);
  }

  if (user && (pathname === "/login" || pathname === "/signup")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/dashboard";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return response;
}
