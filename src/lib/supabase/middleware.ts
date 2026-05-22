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
  "/auth",
  // Phase F0: external operators reach the MCP HTTP bridge via bearer
  // token, not a Supabase cookie. The route handler does its own
  // auth; the middleware must not redirect to /login.
  "/api/mcp",
];

const PUBLIC_EXACT_PATHS = new Set<string>([
  "/",
  "/about",
  "/philosophy",
  "/security",
  "/how-it-works",
  "/login",
  "/signup",
]);

function isPublicPath(pathname: string): boolean {
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
