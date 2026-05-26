import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase F8 — Hashnode identity-scoped publish orchestrator.
 *
 * Mirrors the dev.to / Bluesky pattern. Owns the impure parts of
 * Hashnode publishing:
 *
 *   1. Load the identity row + its platform_connections row.
 *   2. Decrypt the per-identity API key with the existing AES-256-GCM
 *      cipher (same one Bluesky and dev.to use).
 *   3. Resolve publication_id from `platform_connections.metadata`
 *      (operator-set via the Setup page). Legacy env fallback is
 *      opt-in via HASHNODE_LEGACY_FALLBACK=true.
 *   4. Load weekly_plan_items.platform_publish_intent for the item;
 *      refuse before the network call when intent is set and is
 *      NOT "article" (Hashnode is article-only at this adapter's
 *      contract).
 *   5. Hand the decrypted plaintext key to the pure publisher
 *      (`publishToHashnode`) inside a single call frame; plaintext
 *      never escapes this module's stack.
 *
 * Hashnode-style isolation: lives in a Hashnode-owned file, called
 * from the Hashnode branch of `publishing-runner.ts`. Never touches
 * any other platform. Never adds shared cross-platform middleware.
 *
 * Secret hygiene
 * --------------
 *   - The plaintext API key lives in this function's stack frame for
 *     the duration of a single publishToHashnode call only.
 *   - It never appears in any returned outcome, metadata,
 *     execution_log message, or thrown error.
 *   - Encrypted blobs cross module boundaries; plaintext does not.
 */

import { decryptForOutboundUse, getTokenCipher } from "@/core/platform-oauth";
import { getAccountById } from "@/repositories/account-repository";
import { getConnectionForAccount } from "@/repositories/platform-connection-repository";
import { publishToHashnode } from "./publish-hashnode";
import {
  isHashnodeLegacyFallbackEnabled,
  readHashnodeCredentials,
} from "./platform-credentials";
import { publishFail } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";

export interface HashnodeOrchestratorInput {
  request: PublishRequest;
  /**
   * Optional Supabase client. The cron-triggered scheduler tick
   * passes the service-role client so repo lookups
   * (growth_accounts, platform_connections, weekly_plan_items)
   * aren't blocked by RLS in a runtime without an operator cookie.
   * Manual UI callers omit this and pick up the cookie-aware client.
   */
  db?: SupabaseClient;
}

/**
 * Resolves the Hashnode publish path for a scheduled request.
 *
 * Identity-scoped throughout. Touches only the (workspace, account,
 * "hashnode") row.
 */
export async function publishHashnodeForIdentity(
  input: HashnodeOrchestratorInput,
): Promise<PublishOutcome> {
  const { request, db } = input;

  if (!request.accountId) {
    return publishFail(
      "missing_account",
      "Hashnode publish requires an identity (accountId).",
    );
  }

  // 1. Identity row — workspace-scoped lookup. Cross-workspace ids
  // are refused.
  let identity;
  try {
    identity = await getAccountById(request.workspaceId, request.accountId, db);
  } catch {
    return publishFail(
      "missing_account",
      "Identity not found in workspace.",
    );
  }
  if (identity.platform !== "hashnode") {
    return publishFail(
      "platform_mismatch",
      `Identity is on "${identity.platform}", not Hashnode.`,
    );
  }

  // 2. Connection row + API key resolution.
  const conn = await getConnectionForAccount(
    request.workspaceId,
    request.accountId,
    "hashnode" as never,
    db,
  );

  const hasIdentityKey =
    conn !== null &&
    conn.hasAccessToken &&
    (conn.connectionStatus === "connected" ||
      conn.connectionStatus === "expired") &&
    getTokenCipher().isAvailable();

  let apiKey: string | null = null;
  let publicationId: string | null = null;
  let publishPath: "identity" | "legacy_env" = "identity";

  if (hasIdentityKey) {
    const { readEncryptedTokens } = await import(
      "@/repositories/platform-connection-repository"
    );
    const enc = await readEncryptedTokens(request.workspaceId, conn!.id, db);
    if (!enc || !enc.accessTokenEncrypted) {
      return publishFail(
        "hashnode_token_missing",
        "Hashnode connection exists but the encrypted API key is unreadable. Reconnect from the identity card.",
      );
    }
    const decrypted = decryptForOutboundUse(enc.accessTokenEncrypted);
    if (!decrypted) {
      return publishFail(
        "hashnode_token_missing",
        "Hashnode API key could not be decrypted. Reconnect from the identity card.",
      );
    }
    apiKey = decrypted;

    // Publication id comes from connection metadata, set by the
    // operator via /settings/setup. We don't auto-discover because
    // Hashnode's free GraphQL was retired — the verifier can't list
    // publications for most accounts.
    const metaPubId =
      typeof conn!.metadata?.publication_id === "string"
        ? (conn!.metadata.publication_id as string).trim()
        : "";
    if (metaPubId.length > 0) {
      publicationId = metaPubId;
    }
  } else if (isHashnodeLegacyFallbackEnabled()) {
    // Opt-in legacy fallback. Default off in production.
    const creds = readHashnodeCredentials();
    if (creds) {
      apiKey = creds.apiKey;
      publicationId = creds.publicationId;
      publishPath = "legacy_env";
    }
  }

  if (!apiKey) {
    return publishFail(
      "hashnode_token_missing",
      "Hashnode identity has no connected API key. Connect Hashnode from the identity card before publishing.",
    );
  }

  // Legacy env fallback may have provided a publication id; if we're
  // on the identity path and the operator hasn't set one, that's a
  // separate, actionable refusal (operator opens Setup and pastes
  // the id).
  if (!publicationId) {
    // Last-resort: if legacy fallback flag is on, accept the env
    // publication id even on the identity path (covers a single-
    // publication workspace migrating from env to per-identity).
    if (isHashnodeLegacyFallbackEnabled()) {
      const creds = readHashnodeCredentials();
      if (creds?.publicationId) {
        publicationId = creds.publicationId;
      }
    }
  }
  if (!publicationId) {
    return publishFail(
      "hashnode_publication_missing",
      "Hashnode: this identity has no publication selected. Open Settings → Setup → Hashnode and paste the publication id.",
    );
  }

  // 3. Intent gate. Hashnode is article-only — refuse non-article
  // intents BEFORE the network call. Legacy rows (intent === null)
  // bypass the gate so pre-platform-native items still publish via
  // the article-shape minimum contract enforced by publishToHashnode.
  const intentVerdict = await loadAndCheckHashnodeIntent({
    request,
    db,
  });
  if (intentVerdict.kind === "refuse") {
    return publishFail(
      "hashnode_requires_article_intent",
      intentVerdict.reasonDetail,
      { plan_item_id: request.planItemId },
    );
  }

  // 4. Hand to the pure publisher. Plaintext stays in this stack
  // frame for the duration of the single publishToHashnode call.
  const outcome = await publishToHashnode({
    request,
    apiKey,
    publicationId,
  });

  // 5. Tag the outcome with the publish path so audit can grep for
  // legacy-fallback usage in publish_history (mirrors dev.to /
  // Bluesky).
  return tagPublishPath(outcome, publishPath);
}

function tagPublishPath(
  outcome: PublishOutcome,
  path: "identity" | "legacy_env",
): PublishOutcome {
  return {
    ...outcome,
    metadata: {
      ...outcome.metadata,
      hashnode_publish_path: path,
    },
  };
}

/**
 * Hashnode intent gate.
 *
 * Loads weekly_plan_items.platform_publish_intent for this item.
 * Refuses publish when the operator's intent is set AND is NOT
 * "article" (Hashnode is article-only at this adapter's contract).
 * Legacy rows (null intent envelope) proceed; the publisher's
 * minimum article-shape contract still enforces title/body.
 *
 * No-op fallback: any error reading the row is treated as "no
 * intent set" so an observability failure can never block a publish
 * that would otherwise succeed. Mirrors dev.to's gate posture.
 */
async function loadAndCheckHashnodeIntent(input: {
  request: PublishRequest;
  db?: SupabaseClient;
}): Promise<
  { kind: "proceed" } | { kind: "refuse"; reasonDetail: string }
> {
  try {
    const { request } = input;
    const db = input.db;
    const { createSupabaseServerClient } = await import("@/lib/supabase");
    const client = db ?? createSupabaseServerClient();

    const { data: row } = await client
      .from("weekly_plan_items")
      .select("platform_publish_intent")
      .eq("workspace_id", request.workspaceId)
      .eq("id", request.planItemId)
      .maybeSingle();

    const raw =
      (row as { platform_publish_intent: Record<string, unknown> | null } | null)
        ?.platform_publish_intent ?? null;
    if (raw === null) return { kind: "proceed" };
    const intent = typeof raw.intent === "string" ? raw.intent : null;
    if (intent === null) return { kind: "proceed" };
    if (intent === "article" || intent === "unknown") return { kind: "proceed" };
    return {
      kind: "refuse",
      reasonDetail: `Hashnode is article-only. The operator's intent for this item is "${intent}". Set intent=article via MCP or the compose modal before publishing.`,
    };
  } catch (err) {
    console.error(
      "[hashnode-orch] intent gate load failed; proceeding",
      err,
    );
    return { kind: "proceed" };
  }
}
