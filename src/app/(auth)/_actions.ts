"use server";

import { isRedirectError } from "next/dist/client/components/redirect";
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
