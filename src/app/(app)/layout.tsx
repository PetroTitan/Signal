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
import { RepositoryError } from "@/repositories/errors";
import { WorkspaceSessionProvider } from "@/core/workspace-session";
import { SignalShell } from "@/components/signal-shell";
import { BootstrapFailedNotice } from "./_bootstrap-failed";

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
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>["data"]["user"] =
    null;
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

  // Bootstrap is the post-auth danger zone. If it throws, we render a
  // controlled error UI inside the auth shell rather than letting a raw
  // 500 reach the user. The user can sign out from there.
  let membership: Awaited<ReturnType<typeof getPrimaryWorkspace>> = null;
  let bootstrapError: string | null = null;

  try {
    membership = await getPrimaryWorkspace();
    if (!membership) {
      await createWorkspace({ name: "Signal Workspace" });
      membership = await getPrimaryWorkspace();
    }
  } catch (err) {
    console.error("[app/layout] workspace bootstrap failed", err);
    bootstrapError =
      err instanceof RepositoryError
        ? err.message
        : "Workspace bootstrap failed. Try refreshing in a moment.";
  }

  if (bootstrapError || !membership) {
    return (
      <BootstrapFailedNotice
        userEmail={user.email ?? null}
        message={bootstrapError ?? "Workspace not found after bootstrap."}
      />
    );
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
