import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase F7.1 — dev.to identity-scoped publish orchestrator.
 *
 * Owns the impure parts of dev.to publishing:
 *   1. Load the identity row + its platform_connections row.
 *   2. Decrypt the per-identity API key with the existing AES-256-GCM
 *      cipher (the same one Bluesky uses).
 *   3. Load weekly_plan_items.platform_publish_intent for the item;
 *      refuse before the network call when intent !== "article".
 *   4. Hand the decrypted plaintext key to the pure publisher
 *      (`publishToDevto`) inside a single call frame; plaintext
 *      never escapes this module's stack.
 *
 * Bluesky-style isolation: lives in a dev.to-owned file, called
 * from the dev.to branch of `publishing-runner.ts`. Never touches
 * any other platform. Never adds shared cross-platform middleware.
 *
 * Legacy fallback
 * ---------------
 * Mirrors `BLUESKY_LEGACY_FALLBACK`: when
 * `DEVTO_LEGACY_FALLBACK=true` AND no per-identity encrypted key
 * exists AND the workspace-level `DEVTO_API_KEY` env var is set,
 * the publisher uses the env key. Default off — production should
 * leave the flag unset so identities without a connected key fail
 * fast with `devto_token_missing`.
 *
 * Secret hygiene
 * --------------
 *   - The plaintext API key lives in this function's stack frame
 *     for the duration of a single publishToDevto call only.
 *   - It never appears in any returned outcome, metadata,
 *     execution_log message, or thrown error.
 *   - Encrypted blobs cross module boundaries; plaintext does not.
 */

import { decryptForOutboundUse, getTokenCipher } from "@/core/platform-oauth";
import { getAccountById } from "@/repositories/account-repository";
import { getConnectionForAccount } from "@/repositories/platform-connection-repository";
import { publishToDevto } from "./publish-devto";
import {
  isDevtoLegacyFallbackEnabled,
  readDevtoCredentials,
} from "./platform-credentials";
import { publishFail } from "./publishing-result";
import type { PublishOutcome, PublishRequest } from "./publishing-types";

export interface DevtoOrchestratorInput {
  request: PublishRequest;
  /**
   * Optional Supabase client. The cron-triggered scheduler tick
   * passes the service-role client through so the repo lookups
   * (growth_accounts, platform_connections) aren't blocked by RLS
   * in a runtime without an operator cookie. Manual UI callers omit
   * this and pick up the cookie-aware client.
   */
  db?: SupabaseClient;
}

/**
 * Resolves the dev.to publish path for a scheduled request:
 *
 *   1. Workspace-scoped identity check. Refuses cross-platform
 *      identities (intent: "article" + identity.platform="reddit"
 *      would be a routing bug).
 *   2. Load (workspace, accountId, "devto") connection. When the
 *      row carries an encrypted API key, decrypt it for this call
 *      only.
 *   3. Intent gate. We don't load platform_publish_intent here
 *      because `publishToDevto` already produces
 *      `article_title_required` / `article_body_required` from the
 *      raw request fields — those are dev.to's MINIMUM contract
 *      regardless of intent. The richer intent gate (e.g. refusing
 *      `intent !== "article"`) lives in the runner's call site
 *      below so the publisher remains a pure HTTP layer.
 *   4. Hand the decrypted plaintext to the publisher.
 *
 * Identity-scoped throughout. Touches only the (workspace, account,
 * "devto") row.
 */
export async function publishDevtoForIdentity(
  input: DevtoOrchestratorInput,
): Promise<PublishOutcome> {
  const { request, db } = input;

  if (!request.accountId) {
    return publishFail(
      "missing_account",
      "dev.to publish requires an identity (accountId).",
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
  if (identity.platform !== "devto") {
    return publishFail(
      "platform_mismatch",
      `Identity is on "${identity.platform}", not dev.to.`,
    );
  }

  // 2. Connection row.
  const conn = await getConnectionForAccount(
    request.workspaceId,
    request.accountId,
    "devto" as never,
    db,
  );

  const hasIdentityKey =
    conn !== null &&
    conn.hasAccessToken &&
    (conn.connectionStatus === "connected" ||
      conn.connectionStatus === "expired") &&
    getTokenCipher().isAvailable();

  let apiKey: string | null = null;
  if (hasIdentityKey) {
    const { readEncryptedTokens } = await import(
      "@/repositories/platform-connection-repository"
    );
    const enc = await readEncryptedTokens(request.workspaceId, conn!.id, db);
    if (!enc || !enc.accessTokenEncrypted) {
      return publishFail(
        "devto_token_missing",
        "dev.to connection exists but the encrypted API key is unreadable. Reconnect from the identity card.",
      );
    }
    const decrypted = decryptForOutboundUse(enc.accessTokenEncrypted);
    if (!decrypted) {
      return publishFail(
        "devto_token_missing",
        "dev.to API key could not be decrypted. Reconnect from the identity card.",
      );
    }
    apiKey = decrypted;
  } else if (isDevtoLegacyFallbackEnabled()) {
    // Opt-in legacy fallback. Default off in production.
    const creds = readDevtoCredentials();
    if (creds) {
      apiKey = creds.apiKey;
    }
  }

  if (!apiKey) {
    return publishFail(
      "devto_token_missing",
      "dev.to identity has no connected API key. Connect dev.to from the identity card before publishing.",
    );
  }

  // 3. Intent gate. dev.to is article-only — refuse non-article
  // intents BEFORE the network call. Legacy rows (intent === null)
  // bypass the gate so pre-platform-native items still publish via
  // the article-shape minimum contract enforced by publishToDevto.
  const intentVerdict = await loadAndCheckDevtoIntent({
    request,
    db,
  });
  if (intentVerdict.kind === "refuse") {
    return publishFail(
      "devto_requires_article_intent",
      intentVerdict.reasonDetail,
      { plan_item_id: request.planItemId },
    );
  }

  // 4. Hand to the pure publisher. Plaintext stays in this stack
  // frame for the duration of the single publishToDevto call.
  const outcome = await publishToDevto({
    request,
    apiKey,
    published: true,
  });

  // 4. Tag the outcome with the publish path so audit can grep for
  // legacy-fallback usage in publish_history (mirrors Bluesky).
  return tagPublishPath(outcome, hasIdentityKey ? "identity" : "legacy_env");
}

function tagPublishPath(
  outcome: PublishOutcome,
  path: "identity" | "legacy_env",
): PublishOutcome {
  return {
    ...outcome,
    metadata: {
      ...outcome.metadata,
      devto_publish_path: path,
    },
  };
}

/**
 * Phase F7.1 — dev.to intent gate.
 *
 * Loads weekly_plan_items.platform_publish_intent for this item.
 * Refuses publish when the operator's intent is set AND is NOT
 * "article" (dev.to is article-only at this adapter's contract).
 * Legacy rows (null intent envelope) proceed; the publisher's
 * minimum article-shape contract still enforces title/body.
 *
 * No-op fallback: any error reading the row is treated as "no
 * intent set" so an observability failure can never block a publish
 * that would otherwise succeed. Mirrors Bluesky's gate posture.
 */
async function loadAndCheckDevtoIntent(input: {
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
      reasonDetail: `dev.to is article-only. The operator's intent for this item is "${intent}". Set intent=article via MCP or the compose modal before publishing.`,
    };
  } catch (err) {
    console.error(
      "[devto-orch] intent gate load failed; proceeding",
      err,
    );
    return { kind: "proceed" };
  }
}
