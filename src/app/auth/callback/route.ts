import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase";
import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * OAuth / email-confirmation / password-recovery callback.
 *
 * Handles two Supabase verification flows:
 *
 *   - PKCE (`?code=...`): used by OAuth providers and by Supabase's
 *     default email templates (`{{ .ConfirmationURL }}`). Calls
 *     `exchangeCodeForSession`. Requires the `code_verifier` cookie
 *     written when the recovery / sign-in was initiated, so it only
 *     works if the user lands here in the SAME browser session.
 *
 *   - OTP token_hash (`?token_hash=...&type=...`): used by the
 *     Supabase-recommended Next.js email templates. Calls
 *     `verifyOtp`. Does NOT require a `code_verifier` cookie, so
 *     recovery links open from a different device / browser / mail
 *     client work correctly. This is the path the "Reset password"
 *     email template should use — see requestPasswordRecoveryAction
 *     for the template snippet.
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

  if (tokenHash && type) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (error) {
      return NextResponse.redirect(buildErrorUrl(url.origin, isRecovery));
    }
  } else if (code) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return NextResponse.redirect(buildErrorUrl(url.origin, isRecovery));
    }
  }

  const redirectUrl = new URL(safeRedirect(next), url.origin);
  return NextResponse.redirect(redirectUrl);
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
