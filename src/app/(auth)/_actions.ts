"use server";

import { isRedirectError } from "next/dist/client/components/redirect";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  createSupabaseServerClient,
  SupabaseEnvError,
} from "@/lib/supabase";
import { createWorkspace } from "@/repositories/workspace-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";

export interface AuthActionState {
  ok: boolean;
  error: string | null;
}

function handleUnknownAuthError(err: unknown): AuthActionState {
  if (err instanceof SupabaseEnvError) {
    // Server-only log. Diagnostics never contain the anon-key value.
    console.error("[auth] Supabase env misconfigured", err.diagnostics);
    return {
      ok: false,
      error:
        "Authentication is not available right now. The Supabase project URL or anon key is misconfigured for this deployment.",
    };
  }
  console.error("[auth] Unexpected error", err);
  return {
    ok: false,
    error: "Authentication is temporarily unavailable. Please try again shortly.",
  };
}

export async function signInAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  if (!email || !password) {
    return { ok: false, error: "Email and password are required." };
  }

  try {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      return { ok: false, error: friendlyAuthError(error.message) };
    }
    revalidatePath("/", "layout");
    redirect(safeRedirect(next));
  } catch (err) {
    if (isRedirectError(err)) throw err;
    return handleUnknownAuthError(err);
  }
}

export async function signUpAction(
  _prevState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { ok: false, error: "Email and password are required." };
  }
  if (password.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }

  let data: Awaited<
    ReturnType<ReturnType<typeof createSupabaseServerClient>["auth"]["signUp"]>
  >["data"];
  try {
    const supabase = createSupabaseServerClient();
    const result = await supabase.auth.signUp({ email, password });
    if (result.error) {
      return { ok: false, error: friendlyAuthError(result.error.message) };
    }
    data = result.data;
  } catch (err) {
    if (isRedirectError(err)) throw err;
    return handleUnknownAuthError(err);
  }

  // If the project requires email confirmation, signUp returns a user with
  // no session. In that case skip workspace creation — the user will be
  // taken through it after they confirm and log in.
  if (data.session && data.user) {
    try {
      const existing = await getPrimaryWorkspace();
      if (!existing) {
        const workspace = await createWorkspace({ name: "Signal Workspace" });
        await recordActivity({
          workspaceId: workspace.id,
          eventType: "workspace.created",
          entityType: "workspace",
          entityId: workspace.id,
          title: "Workspace created",
          description: "Your first workspace was created on signup.",
        });
      }
    } catch {
      // Non-fatal: the dashboard's missing-workspace flow will retry.
    }
    revalidatePath("/", "layout");
    redirect("/dashboard");
  }

  return {
    ok: true,
    error:
      "Check your email to confirm your account, then sign in to continue.",
  };
}

export async function signOutAction(): Promise<void> {
  try {
    const supabase = createSupabaseServerClient();
    await supabase.auth.signOut();
  } catch (err) {
    // Swallow env / network errors here — we still want to redirect the user.
    console.error("[auth] signOut error", err);
  }
  revalidatePath("/", "layout");
  redirect("/login");
}

export interface RequestRecoveryActionState {
  ok: boolean;
  error: string | null;
}

/**
 * Sends a password recovery email via Supabase. The link delivered to
 * the user lands on /auth/callback?type=recovery&next=/reset-password,
 * which after `exchangeCodeForSession` redirects to /reset-password.
 *
 * Never reveals whether the email is registered: on a successful
 * Supabase call we return `ok: true` regardless of whether a user with
 * that email exists. (Supabase itself rate-limits + does not error on
 * unknown emails for this RPC.)
 */
export async function requestPasswordRecoveryAction(
  _prevState: RequestRecoveryActionState,
  formData: FormData,
): Promise<RequestRecoveryActionState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) {
    return { ok: false, error: "Enter your email address." };
  }

  try {
    const supabase = createSupabaseServerClient();
    const h = headers();
    const host = h.get("host");
    if (!host) {
      return {
        ok: false,
        error: "Could not determine the site URL. Try again shortly.",
      };
    }
    const proto = h.get("x-forwarded-proto") ?? "https";
    const origin = `${proto}://${host}`;
    const redirectTo = `${origin}/auth/callback?type=recovery&next=/reset-password`;

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo,
    });
    if (error) {
      return { ok: false, error: friendlyAuthError(error.message) };
    }
    return { ok: true, error: null };
  } catch (err) {
    if (isRedirectError(err)) throw err;
    return handleUnknownAuthError(err);
  }
}

export interface UpdatePasswordActionState {
  ok: boolean;
  error: string | null;
}

/**
 * Sets a new password for the currently-authenticated user. The page
 * that hosts the form requires an active Supabase session, which the
 * recovery-link click establishes via /auth/callback's
 * `exchangeCodeForSession`. We re-verify the session here as a
 * defense-in-depth check — a missing session means the recovery link
 * has expired or the user opened the form directly.
 *
 * On success we sign the user out and redirect to /login so the next
 * sign-in exercises the new password through the normal flow. The
 * recovery session itself is short-lived and not appropriate as a
 * long-lived app session.
 */
export async function updatePasswordAction(
  _prevState: UpdatePasswordActionState,
  formData: FormData,
): Promise<UpdatePasswordActionState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) {
    return { ok: false, error: "Passwords do not match." };
  }

  try {
    const supabase = createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error:
          "This recovery link is expired or invalid. Request a new password recovery email.",
      };
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      return { ok: false, error: friendlyAuthError(error.message) };
    }
    // Force re-authentication with the new credentials.
    await supabase.auth.signOut();
    revalidatePath("/", "layout");
    redirect("/login?password_updated=1");
  } catch (err) {
    if (isRedirectError(err)) throw err;
    return handleUnknownAuthError(err);
  }
}

function safeRedirect(next: string): string {
  if (!next.startsWith("/")) return "/dashboard";
  if (next.startsWith("//")) return "/dashboard";
  return next;
}

function friendlyAuthError(message: string): string {
  if (message.toLowerCase().includes("invalid login")) {
    return "Email or password is incorrect.";
  }
  if (message.toLowerCase().includes("already registered")) {
    return "An account with this email already exists. Try signing in.";
  }
  return message;
}
