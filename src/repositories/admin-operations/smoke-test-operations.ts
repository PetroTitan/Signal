import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase";
import {
  mcpFail,
  mcpOk,
  type McpOperationResult,
} from "@/core/mcp-operations";
import { getPrimaryWorkspace } from "@/repositories/workspace-repository";
import { logMcpOperation } from "./operation-audit";

export interface SmokeTestPayload {
  workspaceId: string;
  checks: Array<{
    name: string;
    ok: boolean;
    durationMs: number;
    detail: string | null;
  }>;
  allOk: boolean;
}

/**
 * Read-only smoke test of the authenticated user's view of the
 * database. Never writes (other than the activity event). Used by the
 * MCP layer to verify a deployment is healthy before reporting back.
 */
export async function runWorkspaceSmokeTest(): Promise<
  McpOperationResult<SmokeTestPayload>
> {
  const operationType = "smoke_test_run" as const;
  const start = Date.now();
  const supabase = createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return mcpFail(operationType, "Not authenticated.", "not_authenticated", {
      durationMs: Date.now() - start,
    });
  }

  const membership = await getPrimaryWorkspace();
  if (!membership) {
    return mcpFail(operationType, "No workspace found.", "not_authorized", {
      durationMs: Date.now() - start,
    });
  }
  const workspaceId = membership.workspace.id;

  const checks: SmokeTestPayload["checks"] = [];

  async function check(
    name: string,
    fn: () => Promise<{ ok: boolean; detail: string | null }>,
  ) {
    const t0 = Date.now();
    try {
      const r = await fn();
      checks.push({ name, ok: r.ok, durationMs: Date.now() - t0, detail: r.detail });
    } catch (err) {
      checks.push({
        name,
        ok: false,
        durationMs: Date.now() - t0,
        detail: err instanceof Error ? err.message : "Unknown error.",
      });
    }
  }

  await check("auth.getUser", async () => ({
    ok: !!user,
    detail: user?.email ?? null,
  }));

  await check("workspace.read", async () => {
    const { data, error } = await supabase
      .from("workspaces")
      .select("id")
      .eq("id", workspaceId)
      .maybeSingle();
    return {
      ok: !error && !!data,
      detail: error?.message ?? null,
    };
  });

  await check("products.list", async () => {
    const { data, error } = await supabase
      .from("products")
      .select("id")
      .eq("workspace_id", workspaceId)
      .limit(1);
    return {
      ok: !error,
      detail: error?.message ?? `rows=${data?.length ?? 0}`,
    };
  });

  await check("growth_accounts.list", async () => {
    const { data, error } = await supabase
      .from("growth_accounts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .limit(1);
    return {
      ok: !error,
      detail: error?.message ?? `rows=${data?.length ?? 0}`,
    };
  });

  await check("activity_events.list", async () => {
    const { data, error } = await supabase
      .from("activity_events")
      .select("id")
      .eq("workspace_id", workspaceId)
      .limit(1);
    return {
      ok: !error,
      detail: error?.message ?? `rows=${data?.length ?? 0}`,
    };
  });

  const allOk = checks.every((c) => c.ok);

  await logMcpOperation({
    workspaceId,
    operationType,
    source: "mcp_operation",
    title: allOk ? "Smoke test passed" : "Smoke test failed",
    metadata: {
      allOk,
      checks: checks.map((c) => ({ name: c.name, ok: c.ok })),
    },
  });

  return mcpOk(
    operationType,
    { workspaceId, checks, allOk },
    {
      notes: [
        `${checks.filter((c) => c.ok).length}/${checks.length} checks passed.`,
      ],
      durationMs: Date.now() - start,
    },
  );
}
