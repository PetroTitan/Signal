import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  WorkspaceInvitationInsert,
  WorkspaceInvitationRow,
  WorkspaceRole,
} from "@/lib/supabase/types";
import { fromPostgres } from "./errors";

/**
 * Phase C1.1 — workspace invitations.
 *
 * Management reads/writes go through the cookie-aware client (RLS gates
 * to owner/admin). Acceptance goes through the SECURITY DEFINER RPC
 * `accept_workspace_invitation` so an invitee who is not yet a member
 * can accept exactly their own invite. Token plaintext is never stored
 * or returned here — only the hash.
 */

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  status: WorkspaceInvitationRow["status"];
  invitedBy: string | null;
  acceptedBy: string | null;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

function toInvitation(row: WorkspaceInvitationRow): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    acceptedBy: row.accepted_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
  };
}

export async function createInvitation(input: {
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  tokenHash: string;
  expiresAt: string;
  invitedBy: string | null;
}): Promise<WorkspaceInvitation> {
  const supabase = createSupabaseServerClient();
  const insert: WorkspaceInvitationInsert = {
    workspace_id: input.workspaceId,
    email: input.email,
    role: input.role,
    token_hash: input.tokenHash,
    expires_at: input.expiresAt,
    invited_by: input.invitedBy,
  };
  const { data, error } = await supabase
    .from("workspace_invitations")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data) throw fromPostgres(error, "Failed to create invitation.");
  return toInvitation(data as unknown as WorkspaceInvitationRow);
}

export async function listInvitations(
  workspaceId: string,
  opts?: { statuses?: WorkspaceInvitationRow["status"][] },
): Promise<WorkspaceInvitation[]> {
  const supabase = createSupabaseServerClient();
  let q = supabase
    .from("workspace_invitations")
    .select("*")
    .eq("workspace_id", workspaceId);
  if (opts?.statuses && opts.statuses.length > 0) {
    q = q.in("status", opts.statuses as never);
  }
  const { data, error } = await q.order("created_at", { ascending: false }).limit(100);
  if (error) throw fromPostgres(error, "Failed to list invitations.");
  return ((data ?? []) as unknown as WorkspaceInvitationRow[]).map(toInvitation);
}

/**
 * C2.1 — accepted invitations the given user originally sent. Used by
 * the notification sync to raise `invitation_accepted` for the inviter
 * (RLS already restricts reads to owner/admin, so a non-inviter simply
 * gets no rows). Read-only.
 */
export async function listAcceptedInvitationsByInviter(
  workspaceId: string,
  inviterUserId: string,
): Promise<WorkspaceInvitation[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_invitations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("invited_by", inviterUserId)
    .eq("status", "accepted")
    .order("accepted_at", { ascending: false })
    .limit(50);
  if (error) throw fromPostgres(error, "Failed to list accepted invitations.");
  return ((data ?? []) as unknown as WorkspaceInvitationRow[]).map(toInvitation);
}

/** App-layer "one active pending invite per (workspace,email)" check
 *  (the DB also enforces it via a partial unique index). */
export async function findPendingInvitation(
  workspaceId: string,
  email: string,
): Promise<WorkspaceInvitation | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_invitations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("email", email.toLowerCase())
    .eq("status", "pending")
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to look up pending invitation.");
  return data ? toInvitation(data as unknown as WorkspaceInvitationRow) : null;
}

export async function revokeInvitation(input: {
  workspaceId: string;
  invitationId: string;
}): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("workspace_invitations")
    .update({ status: "revoked" } as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.invitationId)
    .eq("status", "pending");
  if (error) throw fromPostgres(error, "Failed to revoke invitation.");
}

/**
 * Accept an invitation via the SECURITY DEFINER RPC. Returns the joined
 * workspace id, or a typed failure derived from the RPC's exception.
 */
export type AcceptInvitationResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" | "wrong_email" | "error"; detail: string };

export async function acceptInvitationByToken(
  tokenHash: string,
): Promise<AcceptInvitationResult> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc("accept_workspace_invitation", {
    p_token_hash: tokenHash,
  });
  if (error) {
    const msg = error.message ?? "";
    if (/not found/i.test(msg)) return { ok: false, reason: "not_found", detail: "Invitation not found." };
    if (/expired/i.test(msg)) return { ok: false, reason: "expired", detail: "This invitation has expired." };
    if (/different email/i.test(msg))
      return { ok: false, reason: "wrong_email", detail: "This invitation is for a different email address." };
    if (/invitation is/i.test(msg)) return { ok: false, reason: "not_pending", detail: msg };
    return { ok: false, reason: "error", detail: msg || "Could not accept the invitation." };
  }
  return { ok: true, workspaceId: data as unknown as string };
}
