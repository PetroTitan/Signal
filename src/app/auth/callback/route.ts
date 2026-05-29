import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";

/**
 * OAuth / email-confirmation / password-recovery callback. Exchanges
 * the `code` query param for a session cookie and redirects.
 *
 * Flow detection:
 *   - `type=recovery` → force redirect to /reset-password regardless of
 *     `next`. The recovery link is the only mechanism by which an
 *     anonymous request can mint a short-lived session, and we must
 *     never let an attacker-controlled `next` divert that session into
 *     the rest of the app.
 *   - everything else (OAuth sign-in, email confirmation, magic-link-
 *     style sign-in if ever enabled) → redirect to a safelisted `next`
 *     or /dashboard.
 *
 * `code` exchange runs identically for both flows. The whole route is
 * already public via the `/auth` middleware prefix.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");
  const isRecovery = type === "recovery";
  const next = isRecovery
    ? "/reset-password"
    : url.searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const errorUrl = new URL("/login", url.origin);
      errorUrl.searchParams.set(
        "error",
        isRecovery ? "recovery_link_invalid" : "callback_failed",
      );
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
