# Runtime checks

Phase E2.6 adds three safety checks that probe the *code* (not the database) to verify documented invariants are still in place. These checks are static-analysis style: they read the relevant source files and assert specific patterns.

## oauth_safety_check

Located at `src/repositories/verification/safety-checks.ts → runOAuthSafetyCheck`.

Verifies:

1. **No publishing scopes.** `oauth-provider.ts` does not contain `tweet.write`, `submit`, `w_member_social`, or `w_organization_social`.
2. **No raw token fields exposed.** `oauth-types.ts` exposes `hasAccessToken` / `hasRefreshToken` booleans only — bare `accessToken` / `refreshToken` field names are flagged.
3. **Cipher gate present.** `token-lifecycle.ts` calls `isAvailable()` before persisting and exports `NOOP_CIPHER`.
4. **Callback records error when cipher unavailable.** `/api/oauth/[platform]/callback/route.ts` sets `connection_status='error'` or `token_storage='not_configured'` instead of silently storing plaintext.
5. **State tokens are one-shot.** `consumeOAuthState` deletes the state row on read.
6. **Disconnect clears tokens.** `markConnectionStatus(revoked)` nulls out `access_token_encrypted`.

Returns `fail` if any rule is violated. Blocking.

## execution_safety_check

Located at `src/repositories/verification/safety-checks.ts → runExecutionSafetyCheck`.

Verifies:

1. **Engine refuses without active contract.** `execution-safety.ts` contains the documented refusal.
2. **`external_publish` invocation is hard-blocked.** Same file.
3. **Demo guard present.** `isDemoWorkspace` check is in `execution-safety.ts`.
4. **Dry-run treats hard_block as blocked.** `dry-run-executor.ts` handles the `hard_block` branch and message declares no external call was made.
5. **RLS on execution_logs is append-only.** Migration has no `for update` or `for delete` policy on `execution_logs`.
6. **Authorization recorded before status update.** In `/execution/_actions.ts`, `recordExecutionAuthorization` appears before `updateItemStatus`.
7. **Pending-review plan items cannot execute.** `queueWeeklyPlanItemsAction` filters to status `approved` / `scheduled`.

Returns `fail` if any rule is violated. Blocking.

## weekly_contract_check

Located at `src/repositories/verification/safety-checks.ts → runWeeklyContractCheck`.

Verifies:

1. **Evaluator covers every reason code.** `contract-evaluator.ts` includes all 10 reason codes (`no_active_contract`, `contract_paused`, `contract_expired`, `action_not_permitted`, `account_out_of_scope`, `product_out_of_scope`, `platform_out_of_scope`, `risk_above_ceiling`, `outside_execution_window`, `demo_mode_blocked`).
2. **Demo-mode guard present.** `isDemoWorkspace` branch in the evaluator.
3. **Paused contracts soft-block.** Evaluator branches on `contract.status === "paused"`.
4. **Policy declares never-granted.** `contract-policy.ts` exports the never-granted constant.
5. **Typed transitions.** `contract-status.ts` exports `canTransition` / `VALID_TRANSITIONS`.

Returns `fail` on any rule violation. Returns `warning` if no evidence could be gathered (the file couldn't be read). Blocking.

## Why static checks

Real provider calls would require credentials Signal doesn't have. Code-level checks are cheap, deterministic, and fail loudly when someone edits the safety boundary without realizing. A future phase can add runtime probes on top — the static checks aren't replaced, they remain as a tripwire.

## See also

- [./full-verification-pipeline.md](./full-verification-pipeline.md)
- [./real-mcp-runtime-integration.md](./real-mcp-runtime-integration.md)
