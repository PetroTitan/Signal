import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/supabase";

/**
 * OAuth / email-confirmation / password-recovery callback.
 *
 * Handles two Supabase verification flows:
 *
 *   - PKCE (`?code=...`): used by OAuth providers and by Supabase's
 *     default email templates (`{{ .ConfirmationURL }}`). Calls
 *     `exchangeCodeForSession`. Requires the `code_verifier` cookie
 *     written when the recovery / sign-in was initiated.
 *
 *   - OTP token_hash (`?token_hash=...&type=...`): used by the
 *     Supabase-recommended Next.js email templates. Calls
 *     `verifyOtp`. Does NOT require a `code_verifier` cookie, so
 *     recovery links opened from a different device / browser / mail
 *     client work correctly. This is the path the "Reset password"
 *     email template should use — see requestPasswordRecoveryAction
 *     for the template snippet.
 *
 * Cookie persistence (THE thing that matters for recovery sessions):
 *
 *   We build the redirect `NextResponse` first and attach session
 *   cookies to it directly via `response.cookies.set` inside the
 *   Supabase client's `setAll` callback. This is the same pattern
 *   used by our middleware. Relying on `next/headers`' `cookies()`
 *   store to implicitly attach Set-Cookie to a later
 *   `NextResponse.redirect(...)` is fragile in Next.js 14: when it
 *   silently fails the user lands on /reset-password with no
 *   session, gets bounced to /login by middleware, signs in with the
 *   old password (creating a NORMAL session, not a recovery
 *   session), and then `updateUser({ password })` is rejected by
 *   Supabase's Secure-Password-Change policy with "Current password
 *   required when setting new password." Attaching cookies to the
 *   explicit response object removes that failure mode.
 *
 * Flow detection:
 *   - `type=recovery` → force redirect to /reset-password regardless of
 *     `next`. The recovery link is the only mechanism by which an
 *     anonymous request can mint a short-lived session, and we must
 *     never let an attacker-controlled `next` divert that session into
 *     the rest of the app.
 *   - everything else → safelisted `next` or /dashboard.
 *
 * The whole route is public via the `/auth` middleware prefix.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const isRecovery = type === "recovery";
  const next = isRecovery
    ? "/reset-password"
    : url.searchParams.get("next") ?? "/dashboard";

  // Build the redirect response FIRST. Any cookies the Supabase client
  // writes during verification land directly on this response.
  const response = NextResponse.redirect(
    new URL(safeRedirect(next), url.origin),
  );

  const env = requireSupabaseEnv();
  const cookieStore = cookies();
  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          // Mirror to the request-scoped store so any in-process reads
          // (none today, but defensive) see the fresh session, AND to
          // the explicit redirect response so the browser actually
          // stores the cookies before following the Location header.
          try {
            cookieStore.set(name, value, options);
          } catch {
            // read-only context — not expected in a route handler
          }
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (error) {
      return NextResponse.redirect(buildErrorUrl(url.origin, isRecovery));
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(buildErrorUrl(url.origin, isRecovery));
    }
  }

  return response;
}

function buildErrorUrl(origin: string, isRecovery: boolean): URL {
  const errorUrl = new URL("/login", origin);
  errorUrl.searchParams.set(
    "error",
    isRecovery ? "recovery_link_invalid" : "callback_failed",
  );
  return errorUrl;
}

function safeRedirect(next: string): string {
  if (!next.startsWith("/")) return "/dashboard";
  if (next.startsWith("//")) return "/dashboard";
  return next;
}
