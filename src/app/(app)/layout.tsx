import { redirect } from "next/navigation";
import { createSupabaseServerClient, isSupabaseConfigured } from "@/lib/supabase";
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
  // When Supabase isn't configured (e.g. local dev without env), render
  // the shell without a workspace session. The demo path still works in
  // that case; new DB-backed surfaces show a config notice instead.
  if (!isSupabaseConfigured()) {
    return <SignalShell>{children}</SignalShell>;
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
