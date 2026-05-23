import "server-only";
import { ok, failed, type McpToolResponse } from "../responses";
import type { ToolContext } from "../tool-context";
import type {
  ExecutionAuthorizeItemArgs,
  ExecutionDryRunArgs,
  VerificationRunCheckArgs,
} from "../schemas";

/**
 * Phase F0 — verification + dry-run tools.
 *
 * These import the existing repository / verification layer at call
 * time so the cookie-aware repository functions can run with the
 * service-role client. Each tool keeps the workspace scope explicit.
 */

const ALLOWED_CHECKS = new Set([
  "env_check",
  "auth_check",
  "rls_check",
  "db_integrity_check",
  "route_protection_check",
  "demo_boundary_check",
  "oauth_safety_check",
  "execution_safety_check",
  "weekly_contract_check",
  "execution_dry_run_smoke",
  "production_smoke_test",
  "supabase_mcp_probe_check",
]);

export async function verificationRun(
  ctx: ToolContext,
): Promise<McpToolResponse> {
  // Read-only summary: returns the latest pipeline operation run +
  // the verdict it recorded. We do not invoke the full pipeline here
  // because runFullVerificationPipeline expects a cookie-bound
  // session; running it under the service-role bypass would skip the
  // operator's RLS scoping. The operator should run the pipeline from
  // /settings/mcp and the MCP tool surfaces the result.
  const { data, error } = await ctx.db
    .from("mcp_operation_runs")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .ilike("input_summary", "%full verification pipeline%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error)
    return failed({
      tool: "signal.verification.run",
      summary: error.message,
    });
  if (!data) {
    return ok({
      tool: "signal.verification.run",
      summary: "No prior verification pipeline run found.",
      data: { run: null },
      warnings: [
        "The MCP server reports the latest pipeline result; trigger a new run from /settings/mcp.",
      ],
    });
  }
  return ok({
    tool: "signal.verification.run",
    summary: `Last verification pipeline: ${(data as { status: string }).status}`,
    data: { run: data },
  });
}

export async function verificationRunCheck(
  ctx: ToolContext,
  args: VerificationRunCheckArgs,
): Promise<McpToolResponse> {
  if (!ALLOWED_CHECKS.has(args.check_name)) {
    return failed({
      tool: "signal.verification.run_check",
      summary: `unknown_check:${args.check_name}`,
    });
  }
  // Look up the latest operation run for this check key by metadata.
  const { data, error } = await ctx.db
    .from("mcp_operation_runs")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error)
    return failed({
      tool: "signal.verification.run_check",
      summary: error.message,
    });
  const rows = (data ?? []) as Array<{
    metadata: Record<string, unknown>;
    [k: string]: unknown;
  }>;
  const match =
    rows.find((r) => (r.metadata as { check?: string }).check === args.check_name) ??
    null;
  if (!match) {
    return ok({
      tool: "signal.verification.run_check",
      summary: `No prior result for ${args.check_name}.`,
      data: { check_name: args.check_name, run: null },
      warnings: [
        "Run the check from /settings/mcp; the MCP server surfaces the persisted result.",
      ],
    });
  }
  return ok({
    tool: "signal.verification.run_check",
    summary: `Last ${args.check_name} run.`,
    data: { check_name: args.check_name, run: match },
  });
}

export async function executionDryRun(
  ctx: ToolContext,
  args: ExecutionDryRunArgs,
): Promise<McpToolResponse> {
  if (!args.queue_id && !args.item_id) {
    return failed({
      tool: "signal.execution.dry_run",
      summary: "queue_id_or_item_id_required",
    });
  }
  // We do not execute the dry-run from the MCP path — the dry-run
  // logic depends on the cookie-bound execution-engine actions. The
  // tool surfaces the most recent dry-run result for the target id so
  // operators can review without triggering a new attempt over MCP.
  const target = args.item_id ?? args.queue_id;
  const column = args.item_id ? "execution_item_id" : "queue_id";
  const { data, error } = await ctx.db
    .from("execution_logs")
    .select("*")
    .eq("workspace_id", ctx.workspaceId)
    .eq(column, target)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error)
    return failed({ tool: "signal.execution.dry_run", summary: error.message });
  return ok({
    tool: "signal.execution.dry_run",
    summary: `Latest execution logs for ${column}=${target}`,
    data: { logs: data ?? [] },
    warnings: [
      "Live dry-run execution must be triggered from /execution; the MCP tool surfaces the persisted logs.",
    ],
  });
}

/**
 * Phase F2.5 — read-only publish preview.
 * Mirrors the /execution/items/[id] page server-side: loads the
 * execution_item, runs `evaluateSafeTestPolicy` with the actual
 * confirmation phrase so every gate runs, and returns the verdict
 * (minus any token material).
 *
 * MCP can use this to *describe* what would happen if the operator
 * clicked Publish, but it cannot actually publish — that requires
 * the cookie-bound operator session and the in-form confirmation
 * input.
 */
export async function executionPublishPreview(
  ctx: ToolContext,
  args: { execution_item_id: string; subreddit?: string | null },
): Promise<McpToolResponse> {
  const { data: item, error } = await ctx.db
    .from("execution_items")
    .select(
      "id, workspace_id, queue_id, account_id, product_id, platform, action_type, title, body, link_url, scheduled_at, status, risk_level, metadata",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.execution_item_id)
    .maybeSingle();
  if (error || !item) {
    return failed({
      tool: "signal.execution.publish_preview",
      summary: error?.message ?? "execution_item_not_found",
    });
  }

  const row = item as {
    id: string;
    workspace_id: string;
    queue_id: string;
    account_id: string | null;
    product_id: string | null;
    platform: string | null;
    action_type: string;
    title: string | null;
    body: string | null;
    link_url: string | null;
    scheduled_at: string | null;
    status: string;
    risk_level: string | null;
    metadata: Record<string, unknown>;
  };

  const { evaluateSafeTestPolicy } = await import(
    "@/core/publishing/safe-test-policy"
  );
  const {
    PUBLISH_CONFIRMATION_PHRASE,
    readAllowedTestSubreddits,
  } = await import("@/core/publishing/safe-test-env");
  const subreddit =
    args.subreddit ??
    (typeof row.metadata?.target === "string"
      ? (row.metadata.target as string)
      : (readAllowedTestSubreddits()[0] ?? null));

  const verdict = await evaluateSafeTestPolicy({
    supabase: ctx.db as never,
    workspaceId: ctx.workspaceId,
    executionItem: {
      id: row.id,
      accountId: row.account_id,
      productId: row.product_id,
      platform: row.platform,
      title: row.title,
      body: row.body,
      linkUrl: row.link_url,
      scheduledAt: row.scheduled_at,
      actionType: row.action_type,
      metadata: row.metadata,
    },
    confirmationPhrase: PUBLISH_CONFIRMATION_PHRASE,
    subreddit,
    nowIso: new Date().toISOString(),
  });

  return ok({
    tool: "signal.execution.publish_preview",
    summary: verdict.ok
      ? "All gates pass — operator must still type the confirmation phrase in /execution/items/<id>."
      : `Blocked: ${verdict.reasonCode}`,
    data: {
      execution_item_id: row.id,
      execution_item_status: row.status,
      policy_verdict: {
        ok: verdict.ok,
        reason_code: verdict.reasonCode,
        reason_detail: verdict.reasonDetail,
        checks: verdict.checks,
      },
      payload_preview: verdict.preview,
      whitelisted_subreddits: readAllowedTestSubreddits(),
    },
    warnings: verdict.ok
      ? [
          "This is a preview only. MCP cannot trigger live publish — the operator must confirm at /execution/items/<id>.",
        ]
      : [verdict.reasonDetail ?? verdict.reasonCode ?? "blocked"],
  });
}

/**
 * Phase F2.6 — manual publish preview.
 *
 * Read-only. Returns everything an operator needs to publish the item
 * manually on Reddit: title, body, subreddit, creative URL, alt text,
 * open-Reddit-submit URL, and a copy-paste-friendly payload string.
 * Also runs the manual-publish policy and returns the verdict so the
 * caller can see exactly which gates pass/fail.
 */
export async function executionManualPublishPreview(
  ctx: ToolContext,
  args: { execution_item_id: string; subreddit?: string | null },
): Promise<McpToolResponse> {
  const { data: item, error } = await ctx.db
    .from("execution_items")
    .select(
      "id, workspace_id, queue_id, account_id, product_id, platform, action_type, title, body, link_url, scheduled_at, status, risk_level, metadata",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.execution_item_id)
    .maybeSingle();
  if (error || !item) {
    return failed({
      tool: "signal.execution.manual_publish_preview",
      summary: error?.message ?? "execution_item_not_found",
    });
  }
  const row = item as {
    id: string;
    workspace_id: string;
    queue_id: string;
    account_id: string | null;
    product_id: string | null;
    platform: string | null;
    action_type: string;
    title: string | null;
    body: string | null;
    link_url: string | null;
    scheduled_at: string | null;
    status: string;
    risk_level: string | null;
    metadata: Record<string, unknown>;
  };

  const { evaluateManualPublishPolicy } = await import(
    "@/core/publishing/manual-publish-policy"
  );
  const {
    PUBLISH_CONFIRMATION_PHRASE,
    readAllowedTestSubreddits,
  } = await import("@/core/publishing/safe-test-env");
  const subreddit =
    args.subreddit ??
    (typeof row.metadata?.target === "string"
      ? (row.metadata.target as string)
      : (readAllowedTestSubreddits()[0] ?? null));

  const verdict = await evaluateManualPublishPolicy({
    supabase: ctx.db as never,
    workspaceId: ctx.workspaceId,
    executionItem: {
      id: row.id,
      accountId: row.account_id,
      productId: row.product_id,
      platform: row.platform,
      title: row.title,
      body: row.body,
      linkUrl: row.link_url,
      scheduledAt: row.scheduled_at,
      actionType: row.action_type,
      metadata: row.metadata,
    },
    confirmationPhrase: PUBLISH_CONFIRMATION_PHRASE,
    subreddit,
    nowIso: new Date().toISOString(),
  });

  const openRedditUrl = subreddit
    ? `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/submit`
    : null;
  const creativeUrl = verdict.preview?.creative?.assetUrl ?? null;
  const altText = verdict.preview?.creative?.altText ?? null;
  const copyablePayload = verdict.preview
    ? [
        `Subreddit: r/${verdict.preview.subreddit}`,
        `Title:\n${verdict.preview.title}`,
        verdict.preview.kind === "link" && verdict.preview.linkUrl
          ? `URL:\n${verdict.preview.linkUrl}`
          : verdict.preview.body
            ? `Body:\n${verdict.preview.body}`
            : "",
        creativeUrl ? `Creative:\n${creativeUrl}` : "",
        altText ? `Alt text:\n${altText}` : "",
      ]
        .filter((s) => s.length > 0)
        .join("\n\n")
    : null;

  return ok({
    tool: "signal.execution.manual_publish_preview",
    summary: verdict.ok
      ? "Manual-publish gates pass. Operator must publish on Reddit manually and paste permalink back at /execution/items/<id>."
      : `Blocked: ${verdict.reasonCode}`,
    data: {
      execution_item_id: row.id,
      execution_item_status: row.status,
      title: verdict.preview?.title ?? row.title,
      body: verdict.preview?.body ?? row.body,
      subreddit,
      creative_url: creativeUrl,
      alt_text: altText,
      open_reddit_url: openRedditUrl,
      copyable_payload: copyablePayload,
      policy_verdict: {
        ok: verdict.ok,
        reason_code: verdict.reasonCode,
        reason_detail: verdict.reasonDetail,
        checks: verdict.checks,
      },
    },
    warnings: verdict.ok
      ? [
          "MCP cannot record the manual publish on its own from a read tool — call signal.execution.record_manual_publish or paste the permalink in /execution/items/<id> after publishing.",
        ]
      : [verdict.reasonDetail ?? verdict.reasonCode ?? "blocked"],
  });
}

/**
 * Phase F2.6 — record a manual publish via MCP.
 *
 * Mirrors the server action but is callable from external operator
 * tooling (Claude/Codex). Validates the permalink, runs the manual
 * policy, inserts publish_history (mode='manual'), walks the
 * execution_item to completed, mirrors the plan_item to published.
 *
 * Does NOT call Reddit. Does NOT bypass any gate. Does NOT trust
 * arbitrary URLs — the permalink must be reddit.com/comments/<id>
 * or redd.it/<id>.
 */
export async function executionRecordManualPublish(
  ctx: ToolContext,
  args: {
    execution_item_id: string;
    permalink: string;
    provider_post_id?: string | null;
    notes?: string | null;
  },
): Promise<McpToolResponse> {
  const { parseRedditPermalink, permalinkRejectionDetail } = await import(
    "@/core/publishing/reddit-permalink"
  );
  const parsed = parseRedditPermalink(args.permalink);
  if (!parsed) {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary: permalinkRejectionDetail(args.permalink),
    });
  }

  // Load the item.
  const { data: itemRow, error: itemErr } = await ctx.db
    .from("execution_items")
    .select(
      "id, workspace_id, queue_id, account_id, product_id, platform, action_type, title, body, link_url, scheduled_at, status, risk_level, metadata",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.execution_item_id)
    .maybeSingle();
  if (itemErr || !itemRow) {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary: itemErr?.message ?? "execution_item_not_found",
    });
  }
  const item = itemRow as {
    id: string;
    workspace_id: string;
    queue_id: string;
    account_id: string | null;
    product_id: string | null;
    platform: string | null;
    action_type: string;
    title: string | null;
    body: string | null;
    link_url: string | null;
    scheduled_at: string | null;
    status: string;
    risk_level: string | null;
    metadata: Record<string, unknown>;
  };
  if (item.status !== "ready" && item.status !== "ready_for_manual_publish") {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary: `Cannot record from '${item.status}'. Item must be 'ready' or 'ready_for_manual_publish'.`,
    });
  }

  // Reconcile subreddit. Permalink subreddit must match the prepared
  // payload's target if both are present.
  const targetSub =
    typeof item.metadata?.target === "string"
      ? (item.metadata.target as string)
      : null;
  if (
    parsed.subreddit &&
    targetSub &&
    parsed.subreddit.toLowerCase() !== targetSub.toLowerCase()
  ) {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary: `Permalink subreddit r/${parsed.subreddit} does not match the prepared payload's r/${targetSub}.`,
    });
  }
  const subreddit = targetSub ?? parsed.subreddit;
  if (!subreddit) {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary:
        "Could not resolve target subreddit. Set metadata.target on the item or pass a permalink that includes /r/<sub>/.",
    });
  }

  // Duplicate-permalink guard. The DB has a unique index, but check
  // here for a clean error.
  const { data: existing } = await ctx.db
    .from("publish_history")
    .select("id, finished_at")
    .eq("workspace_id", ctx.workspaceId)
    .eq("provider_permalink", parsed.normalizedUrl)
    .maybeSingle();
  if (existing) {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary: `Permalink already recorded (history id ${(existing as { id: string }).id}).`,
    });
  }

  // Run the manual policy (MCP path always passes the canonical
  // confirmation phrase — the deliberate operator action lives in
  // the MCP call itself).
  const { evaluateManualPublishPolicy } = await import(
    "@/core/publishing/manual-publish-policy"
  );
  const { PUBLISH_CONFIRMATION_PHRASE } = await import(
    "@/core/publishing/safe-test-env"
  );
  const nowIso = new Date().toISOString();
  const verdict = await evaluateManualPublishPolicy({
    supabase: ctx.db as never,
    workspaceId: ctx.workspaceId,
    executionItem: {
      id: item.id,
      accountId: item.account_id,
      productId: item.product_id,
      platform: item.platform,
      title: item.title,
      body: item.body,
      linkUrl: item.link_url,
      scheduledAt: item.scheduled_at,
      actionType: item.action_type,
      metadata: item.metadata,
    },
    confirmationPhrase: PUBLISH_CONFIRMATION_PHRASE,
    subreddit,
    nowIso,
  });
  if (!verdict.ok) {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary: `Blocked by policy: ${verdict.reasonCode}: ${verdict.reasonDetail}`,
    });
  }

  // Compute fingerprint (uses the same helper as the live path).
  const { computeFingerprint } = await import(
    "@/core/publishing/publish-fingerprint"
  );
  const fp = await computeFingerprint({
    platform: "reddit",
    subreddit,
    title: item.title,
    body: item.body,
    linkUrl: item.link_url,
  });

  // Walk ready/ready_for_manual_publish → running → completed.
  await ctx.db
    .from("execution_items")
    .update({ status: "running" } as never)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", item.id);

  const providerPostId = args.provider_post_id ?? parsed.providerPostId;
  const { data: phRow, error: phErr } = await ctx.db
    .from("publish_history")
    .insert(
      {
        workspace_id: ctx.workspaceId,
        execution_item_id: item.id,
        account_id: item.account_id,
        product_id: item.product_id,
        platform: "reddit",
        subreddit,
        fingerprint: fp.fingerprint,
        title_hash: fp.titleHash,
        body_hash: fp.bodyHash,
        link_url: item.link_url,
        provider_post_id: providerPostId,
        provider_permalink: parsed.normalizedUrl,
        outcome: "published",
        mode: "manual",
        http_status: null,
        started_at: nowIso,
        metadata: {
          publish_method: "manual",
          recorded_via: "mcp",
          operator_token_id: ctx.operatorTokenId,
          notes: args.notes ?? null,
        },
      } as never,
    )
    .select("id")
    .single();
  if (phErr || !phRow) {
    return failed({
      tool: "signal.execution.record_manual_publish",
      summary: phErr?.message ?? "publish_history_insert_failed",
    });
  }

  await ctx.db
    .from("execution_items")
    .update({
      status: "completed",
      metadata: {
        ...item.metadata,
        publish_outcome: {
          status: "published",
          publish_method: "manual",
          external_id: providerPostId,
          external_url: parsed.normalizedUrl,
          published_at: new Date().toISOString(),
        },
      },
    } as never)
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", item.id);

  const planItemId =
    (item.metadata as { plan_item_id?: string })?.plan_item_id ?? null;
  if (planItemId) {
    await ctx.db
      .from("weekly_plan_items")
      .update({ status: "published" } as never)
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", planItemId);
  }

  await ctx.db.from("execution_logs").insert(
    {
      workspace_id: ctx.workspaceId,
      queue_id: item.queue_id,
      execution_item_id: item.id,
      event_type: "item.completed",
      severity: "info",
      message: `[manual-publish] recorded via MCP — ${parsed.normalizedUrl}`,
      metadata: {
        permalink: parsed.normalizedUrl,
        provider_post_id: providerPostId,
        subreddit,
        publish_method: "manual",
        mode: "manual",
        recorded_via: "mcp",
        operator_token_id: ctx.operatorTokenId,
      },
    } as never,
  );

  await ctx.db.from("activity_events").insert(
    {
      workspace_id: ctx.workspaceId,
      event_type: "manual_publish.recorded",
      entity_type: "execution_item",
      entity_id: item.id,
      title: `Manual publish recorded via MCP — r/${subreddit}`,
      description: parsed.normalizedUrl,
      source: "mcp_operation",
      metadata: {
        permalink: parsed.normalizedUrl,
        provider_post_id: providerPostId,
        operator_token_id: ctx.operatorTokenId,
        notes: args.notes ?? null,
      },
    } as never,
  );

  return ok({
    tool: "signal.execution.record_manual_publish",
    summary: `Manual publish recorded — ${parsed.normalizedUrl}`,
    data: {
      execution_item_id: item.id,
      publish_history_id: (phRow as { id: string }).id,
      permalink: parsed.normalizedUrl,
      provider_post_id: providerPostId,
    },
  });
}

export async function executionAuthorizeItem(
  ctx: ToolContext,
  args: ExecutionAuthorizeItemArgs,
): Promise<McpToolResponse> {
  // Returns the authorization outcome for the item if one exists, or
  // reports that the operator must trigger authorization from
  // /execution. We deliberately do not write new execution_authorizations
  // rows from the MCP path; the runner does that under the operator's
  // session.
  const { data: item, error: itemErr } = await ctx.db
    .from("execution_items")
    .select(
      "id, queue_id, contract_id, status, action_type, account_id, product_id, platform, authorization_id, risk_level, risk_score",
    )
    .eq("workspace_id", ctx.workspaceId)
    .eq("id", args.execution_item_id)
    .maybeSingle();
  if (itemErr)
    return failed({
      tool: "signal.execution.authorize_item",
      summary: itemErr.message,
    });
  if (!item) {
    return failed({
      tool: "signal.execution.authorize_item",
      summary: "execution_item_not_found",
    });
  }
  const authorizationId = (item as { authorization_id: string | null })
    .authorization_id;
  let authorization = null;
  if (authorizationId) {
    const { data } = await ctx.db
      .from("execution_authorizations")
      .select("*")
      .eq("workspace_id", ctx.workspaceId)
      .eq("id", authorizationId)
      .maybeSingle();
    authorization = data ?? null;
  }
  return ok({
    tool: "signal.execution.authorize_item",
    summary: authorization
      ? `Authorization ${(authorization as { outcome: string }).outcome}`
      : "No authorization recorded yet for this item.",
    data: { item, authorization },
    warnings: authorization
      ? []
      : [
          "Trigger authorize from /execution under the operator's session to mint a new authorization row.",
        ],
  });
}
