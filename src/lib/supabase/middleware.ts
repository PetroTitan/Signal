import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { readSupabaseEnv } from "./env";

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
 * request and redirects unauthenticated users away from protected app
 * routes. Returns the response untouched if Supabase is not configured —
 * in that case every route renders, which is the desired behavior for
 * local development without env vars.
 */
export async function updateSession(request: NextRequest) {
  const env = readSupabaseEnv();
  if (!env) {
    return NextResponse.next({ request });
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  if (!user && !isPublicPath(pathname)) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
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
