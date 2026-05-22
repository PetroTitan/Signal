import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

/**
 * OAuth / email-confirmation callback. Exchanges the `code` query param
 * for a session cookie and redirects to `next` (defaults to /dashboard).
 *
 * This route is also the redirect target for Supabase's email
 * confirmation flow when the project requires email verification.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const errorUrl = new URL("/login", url.origin);
      errorUrl.searchParams.set("error", "callback_failed");
      return NextResponse.redirect(errorUrl);
    }
  }

  const redirectUrl = new URL(safeRedirect(next), url.origin);
  return NextResponse.redirect(redirectUrl);
}

function safeRedirect(next: string): string {
  if (!next.startsWith("/")) return "/dashboard";
  if (next.startsWith("//")) return "/dashboard";
  return next;
}
