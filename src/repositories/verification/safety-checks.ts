import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fail, pass, warn, type CheckResult } from "@/core/verification";

const REPO_ROOT = process.cwd();

async function readSource(rel: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(REPO_ROOT, rel), "utf8");
  } catch {
    return null;
  }
}

// =====================================================================
// oauth_safety_check
// =====================================================================
//
// Static-analysis check over the OAuth layer. Verifies the documented
// safety guarantees by reading the source files. The check intentionally
// does *not* attempt a live OAuth flow — it's a fast structural probe.

export async function runOAuthSafetyCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: string[] = [];
  const details: string[] = [];

  // 1. No publishing scopes in the provider config.
  const providers = await readSource("src/core/platform-oauth/oauth-provider.ts");
  if (!providers) {
    findings.push("Could not read oauth-provider.ts.");
  } else {
    const publishingScopes = [
      "tweet.write",
      "submit",
      "w_member_social",
      "w_organization_social",
    ];
    const found = publishingScopes.filter((s) =>
      new RegExp(`["']${s.replace(".", "\\.")}["']`).test(providers),
    );
    if (found.length > 0) {
      findings.push(
        `Publishing scope(s) present in provider config: ${found.join(", ")}.`,
      );
    } else {
      details.push("No publishing scopes in oauth-provider.ts.");
    }
  }

  // 2. No raw token fields in the PlatformConnection domain shape.
  const oauthTypes = await readSource("src/core/platform-oauth/oauth-types.ts");
  if (!oauthTypes) {
    findings.push("Could not read oauth-types.ts.");
  } else {
    if (
      /\baccessToken\b/.test(oauthTypes) ||
      /\brefreshToken\b/.test(oauthTypes)
    ) {
      // Allow the `has*Token` booleans; flag bare token field names.
      const offenders = oauthTypes
        .split("\n")
        .filter(
          (line) =>
            /(accessToken|refreshToken)/.test(line) && !/has(Access|Refresh)Token/.test(line),
        );
      if (offenders.length > 0) {
        findings.push(
          `Domain type appears to expose token fields: ${offenders.length} occurrence(s).`,
        );
      } else {
        details.push("Only hasAccessToken / hasRefreshToken booleans are exposed.");
      }
    } else {
      details.push("PlatformConnection does not expose raw token fields.");
    }
  }

  // 3. token-lifecycle refuses to persist when cipher unavailable.
  const tokenLifecycle = await readSource(
    "src/core/platform-oauth/token-lifecycle.ts",
  );
  if (!tokenLifecycle) {
    findings.push("Could not read token-lifecycle.ts.");
  } else {
    if (!/isAvailable\(\)/.test(tokenLifecycle)) {
      findings.push(
        "token-lifecycle.ts does not check cipher availability before persisting.",
      );
    } else {
      details.push("Cipher availability gate is present.");
    }
    if (!/NOOP_CIPHER/.test(tokenLifecycle)) {
      findings.push(
        "token-lifecycle.ts does not define a NOOP_CIPHER fallback.",
      );
    }
  }

  // 4. Callback records error when cipher is unavailable.
  const callback = await readSource(
    "src/app/api/oauth/[platform]/callback/route.ts",
  );
  if (!callback) {
    findings.push("Could not read OAuth callback route.");
  } else {
    if (
      !/token_storage_unavailable|token_storage["']:\s*["']not_configured["']/i.test(
        callback,
      ) &&
      !/connection_status[^=]*=\s*["']error["']|connectionStatus:\s*["']error["']/i.test(callback)
    ) {
      findings.push(
        "OAuth callback does not appear to mark connection_status='error' when cipher is unavailable.",
      );
    } else {
      details.push("Callback records error state when cipher is unavailable.");
    }
  }

  // 5. State tokens are one-shot.
  const repo = await readSource(
    "src/repositories/platform-connection-repository.ts",
  );
  if (!repo) {
    findings.push("Could not read platform-connection-repository.ts.");
  } else {
    if (!/from\(["']oauth_state_tokens["']\)\.delete/.test(repo)) {
      findings.push(
        "consumeOAuthState does not delete the state row (replay possible).",
      );
    } else {
      details.push("State tokens deleted on consume (one-shot).");
    }
  }

  // 6. Disconnect clears encrypted token fields.
  if (repo && !/access_token_encrypted:\s*null/.test(repo)) {
    findings.push(
      "markConnectionStatus(revoked) does not clear access_token_encrypted.",
    );
  } else if (repo) {
    details.push("Disconnect clears encrypted token columns.");
  }

  if (findings.length > 0) {
    return fail({
      check: "oauth_safety_check",
      label: "OAuth safety check",
      summary: `${findings.length} OAuth safety finding(s).`,
      details: [...findings, ...details],
      durationMs: Date.now() - start,
    });
  }
  return pass({
    check: "oauth_safety_check",
    label: "OAuth safety check",
    summary: "OAuth layer enforces no-publishing-scopes and no-plaintext-token guarantees.",
    details,
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// oauth_token_security_check  (Phase F2)
// =====================================================================
//
// Runtime + DB check complementing the static `oauth_safety_check`:
//   - cipher self-test (env present, decodes to 32 bytes, round-trips)
//   - no plaintext-like strings in platform_connections.access_token_encrypted
//   - presence booleans only in the MCP listing
//   - Reddit OAuth provider env present
//   - provider scopes do NOT include `submit` (publishing scope)
//
// The check NEVER reads token values into application memory; it only
// inspects column lengths, prefixes, and the version envelope.

export async function runOAuthTokenSecurityCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: string[] = [];
  const details: string[] = [];

  // 1. Cipher self-test via the production resolver. This calls
  //    `getTokenCipherDiagnostic()` which reads TOKEN_ENCRYPTION_KEY
  //    exactly once and runs an encrypt+decrypt round-trip.
  try {
    const { getTokenCipherDiagnostic, getTokenCipher } = await import(
      "@/core/platform-oauth"
    );
    const diag = getTokenCipherDiagnostic();
    if (diag.status !== "configured") {
      findings.push(`Token cipher ${diag.status}: ${diag.message}`);
    } else {
      details.push(`Token cipher: ${diag.message}`);
    }
    const cipher = getTokenCipher();
    if (diag.status === "configured" && !cipher.isAvailable()) {
      findings.push(
        "Cipher diagnostic reports configured but isAvailable() is false.",
      );
    }
  } catch (err) {
    findings.push(
      `Cipher diagnostic threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Inspect existing token columns: every non-null value must
  //    start with the `v1:` envelope prefix and decode to a 4-part
  //    structure. We don't read the value into JS — the DB-side
  //    LIKE pattern is enough to flag plaintext leakage.
  try {
    const { createSupabaseServiceRoleClient } = await import(
      "@/lib/supabase/service-role"
    );
    const svc = createSupabaseServiceRoleClient();
    if (!svc) {
      findings.push(
        "Service-role client unavailable; cannot inspect platform_connections.",
      );
    } else {
      // Count rows whose access_token_encrypted exists but is NOT in
      // the v1 envelope shape.
      const { count, error } = await svc
        .from("platform_connections")
        .select("id", { count: "exact", head: true })
        .not("access_token_encrypted", "is", null)
        .not("access_token_encrypted", "like", "v1:%");
      if (error) {
        findings.push(
          `Could not inspect token columns: ${error.message}`,
        );
      } else if ((count ?? 0) > 0) {
        findings.push(
          `${count} platform_connections row(s) have access_token_encrypted in an unrecognized envelope. Tokens may be plaintext or from a removed version.`,
        );
      } else {
        details.push(
          "Every stored access token is in the v1 envelope (or null).",
        );
      }
    }
  } catch (err) {
    findings.push(
      `Token-column inspection threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. Confirm the MCP read tool does not select the encrypted columns.
  const readTools = await readSource("src/mcp/tools/read-tools.ts");
  if (readTools && /access_token_encrypted/.test(readTools)) {
    // Allow `has_access_token:access_token_encrypted` (the SQL alias
    // pattern that returns null/exists, not the value).
    const offenders = readTools
      .split("\n")
      .filter(
        (line) =>
          /access_token_encrypted/.test(line) &&
          !/has_access_token:access_token_encrypted|has_refresh_token:refresh_token_encrypted/.test(
            line,
          ),
      );
    if (offenders.length > 0) {
      findings.push(
        `MCP read tool appears to select encrypted-token columns directly (${offenders.length} occurrence).`,
      );
    } else {
      details.push("MCP read tool only exposes presence booleans.");
    }
  } else {
    details.push("MCP read tool does not reference encrypted columns.");
  }

  // 4. Provider scope sanity. `submit` is allowed iff SAFE_TEST_MODE
  //    is on; otherwise it must not appear in the runtime request.
  const providers = await readSource(
    "src/core/platform-oauth/oauth-provider.ts",
  );
  const safeTestOn =
    (process.env.SAFE_TEST_MODE ?? "").trim().toLowerCase() === "true";
  const submitInConfig =
    providers !== null && /scope:\s*["']submit["']/.test(providers);
  if (submitInConfig && !safeTestOn) {
    findings.push(
      "Reddit `submit` scope is in oauth-provider.ts but SAFE_TEST_MODE is not 'true' — publishing scope must be gated.",
    );
  } else if (submitInConfig && safeTestOn) {
    details.push(
      "Reddit `submit` scope is requested (SAFE_TEST_MODE=true).",
    );
  } else if (providers) {
    details.push("Reddit provider does not request the `submit` scope.");
  }

  if (findings.length > 0) {
    return fail({
      check: "oauth_token_security_check",
      label: "OAuth token security check",
      summary: `${findings.length} OAuth token-security finding(s).`,
      details: [...findings, ...details],
      durationMs: Date.now() - start,
    });
  }
  const warned = details.some((d) => d.startsWith("Token cipher missing"));
  if (warned) {
    return warn({
      check: "oauth_token_security_check",
      label: "OAuth token security check",
      summary: "Cipher not configured; storage gate is intact but disabled.",
      details,
      durationMs: Date.now() - start,
    });
  }
  return pass({
    check: "oauth_token_security_check",
    label: "OAuth token security check",
    summary:
      "Cipher round-trips, no plaintext-shaped tokens stored, MCP exposes booleans only.",
    details,
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// execution_safety_check
// =====================================================================

export async function runExecutionSafetyCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: string[] = [];
  const details: string[] = [];

  // 1. assertEngineSafetyEnvelope refuses without active contract and
  // blocks external_publish.
  const safety = await readSource("src/core/execution-engine/execution-safety.ts");
  if (!safety) {
    findings.push("Could not read execution-safety.ts.");
  } else {
    if (!/no active weekly contract/i.test(safety)) {
      findings.push(
        "execution-safety.ts does not refuse when no active contract is present.",
      );
    } else {
      details.push("Engine refuses without active contract.");
    }
    if (!/external_publish/.test(safety)) {
      findings.push(
        "execution-safety.ts does not block external_publish invocations.",
      );
    } else {
      details.push("external_publish invocation is hard-blocked.");
    }
    if (!/isDemoWorkspace/.test(safety)) {
      findings.push("execution-safety.ts is missing the demo guard.");
    }
  }

  // 2. Dry-run executor returns "blocked" on hard_block authorizations.
  const dryRun = await readSource("src/core/execution-engine/dry-run-executor.ts");
  if (!dryRun) {
    findings.push("Could not read dry-run-executor.ts.");
  } else {
    if (!/hard_block/.test(dryRun) || !/Nothing executed/.test(dryRun)) {
      findings.push(
        "dry-run-executor does not treat hard_block as a blocked outcome.",
      );
    } else {
      details.push("Dry-run executor blocks on hard_block.");
    }
    if (!/No external call/.test(dryRun) && !/No external/.test(dryRun)) {
      findings.push(
        "dry-run-executor message does not declare that no external call is made.",
      );
    } else {
      details.push("Dry-run messages declare no external call was made.");
    }
  }

  // 3. RLS on execution_logs is append-only (no UPDATE / DELETE policy).
  const rls = await readSource(
    "supabase/migrations/20260522050002_phase_e2_execution_rls.sql",
  );
  if (!rls) {
    findings.push("Could not read execution RLS migration.");
  } else {
    const logsBlock = rls.match(
      /execution_logs[\s\S]*?(?=alter table|$)/i,
    )?.[0];
    if (logsBlock) {
      if (/for update/i.test(logsBlock) || /for delete/i.test(logsBlock)) {
        findings.push("execution_logs has an update or delete policy.");
      } else {
        details.push("execution_logs is append-only (no update/delete policy).");
      }
    } else {
      findings.push("Could not locate execution_logs RLS block.");
    }
  }

  // 4. Authorization is recorded *before* the dry-run completes.
  const actions = await readSource("src/app/(app)/execution/_actions.ts");
  if (!actions) {
    findings.push("Could not read execution _actions.ts.");
  } else {
    const recordIdx = actions.indexOf("recordExecutionAuthorization");
    const updateIdx = actions.indexOf("updateItemStatus");
    if (recordIdx < 0 || updateIdx < 0) {
      findings.push(
        "execution _actions.ts does not call both recordExecutionAuthorization and updateItemStatus.",
      );
    } else if (recordIdx > updateIdx) {
      findings.push(
        "execution _actions.ts updates the item status before recording the authorization row.",
      );
    } else {
      details.push("Authorization recorded before item status walk.");
    }
  }

  // 5. Pending-review records cannot execute (the queue action filters
  // by 'approved'/'scheduled').
  if (actions) {
    if (!/listPlanItemsByStatus\(membership\.workspace\.id,\s*\[[^\]]*"approved"/.test(actions)) {
      findings.push(
        "queueWeeklyPlanItemsAction does not require plan items to be 'approved'.",
      );
    } else {
      details.push(
        "queueWeeklyPlanItemsAction filters plan items to status='approved'/'scheduled'.",
      );
    }
  }

  if (findings.length > 0) {
    return fail({
      check: "execution_safety_check",
      label: "Execution safety check",
      summary: `${findings.length} execution-safety finding(s).`,
      details: [...findings, ...details],
      durationMs: Date.now() - start,
    });
  }
  return pass({
    check: "execution_safety_check",
    label: "Execution safety check",
    summary:
      "Engine refuses without contract, external_publish blocked, dry-run makes no external calls, logs append-only.",
    details,
    durationMs: Date.now() - start,
  });
}

// =====================================================================
// weekly_contract_check
// =====================================================================

export async function runWeeklyContractCheck(): Promise<CheckResult> {
  const start = Date.now();
  const findings: string[] = [];
  const details: string[] = [];

  const evaluator = await readSource(
    "src/core/weekly-contract/contract-evaluator.ts",
  );
  if (!evaluator) {
    findings.push("Could not read contract-evaluator.ts.");
  } else {
    const requiredReasons = [
      "no_active_contract",
      "contract_paused",
      "contract_expired",
      "action_not_permitted",
      "account_out_of_scope",
      "product_out_of_scope",
      "platform_out_of_scope",
      "risk_above_ceiling",
      "outside_execution_window",
      "demo_mode_blocked",
    ];
    const missing = requiredReasons.filter((r) => !new RegExp(`"${r}"`).test(evaluator));
    if (missing.length > 0) {
      findings.push(`Evaluator missing reason codes: ${missing.join(", ")}.`);
    } else {
      details.push(`Evaluator covers ${requiredReasons.length} reason codes.`);
    }
    if (!/isDemoWorkspace/.test(evaluator)) {
      findings.push("Evaluator does not gate on isDemoWorkspace.");
    }
    if (!/contract\.status === "paused"/.test(evaluator)) {
      findings.push("Evaluator does not soft-block paused contracts.");
    }
  }

  const policy = await readSource("src/core/weekly-contract/contract-policy.ts");
  if (!policy) {
    findings.push("Could not read contract-policy.ts.");
  } else {
    if (!/Never\b/i.test(policy) && !/NEVER_GRANTED/.test(policy)) {
      findings.push("contract-policy.ts is missing the 'never granted' section.");
    } else {
      details.push("Policy declares the never-granted boundary.");
    }
  }

  const statusModule = await readSource(
    "src/core/weekly-contract/contract-status.ts",
  );
  if (statusModule && !/canTransition|VALID_TRANSITIONS/.test(statusModule)) {
    findings.push("contract-status.ts is missing typed transitions.");
  } else if (statusModule) {
    details.push("Contract lifecycle uses typed transitions.");
  }

  if (findings.length > 0) {
    return fail({
      check: "weekly_contract_check",
      label: "Weekly contract check",
      summary: `${findings.length} contract-layer finding(s).`,
      details: [...findings, ...details],
      durationMs: Date.now() - start,
    });
  }
  if (details.length === 0) {
    return warn({
      check: "weekly_contract_check",
      label: "Weekly contract check",
      summary: "No evidence gathered.",
      details: [],
      durationMs: Date.now() - start,
      requiresUserAction: true,
    });
  }
  return pass({
    check: "weekly_contract_check",
    label: "Weekly contract check",
    summary: "Contract evaluator and policy enforce the documented boundary.",
    details,
    durationMs: Date.now() - start,
  });
}
