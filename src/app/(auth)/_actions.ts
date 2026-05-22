"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase";
import { createWorkspace } from "@/repositories/workspace-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";

export interface AuthActionState {
  ok: boolean;
  error: string | null;
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

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { ok: false, error: friendlyAuthError(error.message) };
  }

  revalidatePath("/", "layout");
  redirect(safeRedirect(next));
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

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    return { ok: false, error: friendlyAuthError(error.message) };
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
  const supabase = createSupabaseServerClient();
  await supabase.auth.signOut();
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
