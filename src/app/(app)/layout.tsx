import { redirect } from "next/navigation";
import {
  createSupabaseServerClient,
  isSupabaseConfigured,
} from "@/lib/supabase";
import {
  createWorkspace,
  getPrimaryWorkspace,
} from "@/repositories/workspace-repository";
import { getSettings } from "@/repositories/settings-repository";
import { recordActivity } from "@/repositories/activity-repository";
import { WorkspaceSessionProvider } from "@/core/workspace-session";
import { SignalShell } from "@/components/signal-shell";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fail-closed: a missing or invalid Supabase env means we cannot
  // verify the user. Middleware redirects most traffic before we ever
  // reach this layout, but the redirect here is the backstop. Demo
  // mode does not bypass auth — it only seeds fixtures inside the
  // authenticated shell.
  if (!isSupabaseConfigured()) {
    redirect("/login?reason=auth_unavailable");
  }

  const supabase = createSupabaseServerClient();
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"] = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
  } catch (err) {
    console.error("[app/layout] supabase.auth.getUser failed", err);
    user = null;
  }
  if (!user) {
    redirect("/login");
  }

  let membership = await getPrimaryWorkspace();
  if (!membership) {
    const workspace = await createWorkspace({ name: "Signal Workspace" });
    await recordActivity({
      workspaceId: workspace.id,
      eventType: "workspace.created",
      entityType: "workspace",
      entityId: workspace.id,
      title: "Workspace created",
      description: "Your first workspace was created.",
    });
    membership = await getPrimaryWorkspace();
  }

  if (!membership) {
    redirect("/login");
  }

  const settings = await getSettings(membership.workspace.id);

  return (
    <WorkspaceSessionProvider
      value={{
        user: { id: user.id, email: user.email ?? null },
        workspace: membership.workspace,
        settings,
        role: membership.role,
      }}
    >
      <SignalShell>{children}</SignalShell>
    </WorkspaceSessionProvider>
  );
}
