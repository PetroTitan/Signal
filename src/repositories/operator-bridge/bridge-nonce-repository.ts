import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import type {
  OperatorBridgeNonceInsert,
  OperatorBridgeNonceRow,
  OperatorBridgeNonceUpdate,
} from "@/lib/supabase/types";
import {
  BRIDGE_NONCE_TTL_MS,
  generateNonce,
  type OperatorBridgeNonce,
} from "@/core/operator-bridge";
import { fromPostgres } from "../errors";

function toNonce(row: OperatorBridgeNonceRow): OperatorBridgeNonce {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    nonce: row.nonce,
    status: row.status,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  };
}

export async function createNonce(input: {
  workspaceId: string;
  requestId: string;
  expiresAt?: string;
}): Promise<OperatorBridgeNonce> {
  const supabase = createSupabaseServerClient();
  const nonce = generateNonce();
  const expiresAt =
    input.expiresAt ??
    new Date(Date.now() + BRIDGE_NONCE_TTL_MS).toISOString();
  const insert: OperatorBridgeNonceInsert = {
    workspace_id: input.workspaceId,
    request_id: input.requestId,
    nonce,
    status: "active",
    expires_at: expiresAt,
  };
  const { data, error } = await supabase
    .from("operator_bridge_nonces")
    .insert(insert as never)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to create bridge nonce.");
  return toNonce(data as unknown as OperatorBridgeNonceRow);
}

/**
 * Returns the nonce row (if any) and atomically marks it `used` when
 * we find an active match. Subsequent calls see status='used' and the
 * verifier rejects.
 *
 * Two-step: select then update. The unique constraint on `nonce`
 * keeps the row identifiable; the update is filtered by `status =
 * 'active'` so a second concurrent caller cannot also consume it.
 */
export async function consumeNonce(input: {
  workspaceId: string;
  nonce: string;
}): Promise<OperatorBridgeNonce | null> {
  const supabase = createSupabaseServerClient();
  const { data: existing, error } = await supabase
    .from("operator_bridge_nonces")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("nonce", input.nonce)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load bridge nonce.");
  if (!existing) return null;
  const row = existing as unknown as OperatorBridgeNonceRow;
  if (row.status !== "active") {
    return toNonce(row);
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await markNonceStatus({
      workspaceId: input.workspaceId,
      nonceId: row.id,
      status: "expired",
    });
    return toNonce({ ...row, status: "expired" });
  }
  const updated = await markNonceStatus({
    workspaceId: input.workspaceId,
    nonceId: row.id,
    status: "used",
    usedAt: new Date().toISOString(),
  });
  return updated;
}

export async function markNonceStatus(input: {
  workspaceId: string;
  nonceId: string;
  status: OperatorBridgeNonce["status"];
  usedAt?: string | null;
}): Promise<OperatorBridgeNonce> {
  const supabase = createSupabaseServerClient();
  const patch: OperatorBridgeNonceUpdate = {
    status: input.status,
    used_at: input.usedAt ?? null,
  };
  const { data, error } = await supabase
    .from("operator_bridge_nonces")
    .update(patch as never)
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.nonceId)
    .select("*")
    .single();
  if (error || !data)
    throw fromPostgres(error, "Failed to update bridge nonce.");
  return toNonce(data as unknown as OperatorBridgeNonceRow);
}

export async function getActiveNonceForRequest(input: {
  workspaceId: string;
  requestId: string;
}): Promise<OperatorBridgeNonce | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("operator_bridge_nonces")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("request_id", input.requestId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw fromPostgres(error, "Failed to load active nonce.");
  if (!data) return null;
  return toNonce(data as unknown as OperatorBridgeNonceRow);
}
