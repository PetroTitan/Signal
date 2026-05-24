/**
 * Phase F5.2 — MCP client config snippets.
 *
 * Founder-ready, paste-into-config text for each supported assistant.
 * Built deterministically from the workspace's MCP endpoint URL +
 * the plaintext token that was JUST created (and will never be
 * visible again). The snippets are generated client-side AFTER the
 * server action returns, so the plaintext lives only in the
 * founder's browser tab.
 *
 * Reference shapes:
 *   - Claude Code:  ~/.claude/settings.json (mcpServers map)
 *   - Codex CLI:    same mcpServers map shape
 *   - Generic MCP:  any client following the canonical
 *                   mcpServers / command / args / env contract
 */

export interface SnippetInput {
  endpoint: string;
  /** Plaintext bearer token — present only at create time. */
  token: string;
  /** Friendly name shown in the snippet's `signal` key. */
  serverKey?: string;
}

export interface SnippetOutput {
  claudeCode: string;
  codex: string;
  generic: string;
  curlSmokeTest: string;
}

export function buildSnippets(input: SnippetInput): SnippetOutput {
  const serverKey = input.serverKey ?? "signal";
  const endpoint = input.endpoint.replace(/\s+/g, "");
  const token = input.token;

  const claudeCode = JSON.stringify(
    {
      mcpServers: {
        [serverKey]: {
          command: "npx",
          args: ["mcp-remote", endpoint],
          env: {
            AUTHORIZATION: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  );

  // Codex CLI uses the same mcpServers map structure but reads
  // `headers` directly instead of going through `env` → some
  // versions; both forms are accepted. We emit the env form for
  // consistency with Claude Code.
  const codex = claudeCode;

  const generic = JSON.stringify(
    {
      mcpServers: {
        [serverKey]: {
          url: endpoint,
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      },
    },
    null,
    2,
  );

  // Optional sanity-check the founder can run from a terminal. We
  // intentionally do NOT pretend this verifies the connection —
  // it's a one-shot curl that tells the operator the endpoint is
  // reachable and the token is accepted.
  const curlSmokeTest = [
    `curl -i \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  ${endpoint}`,
  ].join("\n");

  return { claudeCode, codex, generic, curlSmokeTest };
}

/**
 * Resolve the MCP endpoint URL for the running deployment. Falls back
 * to localhost so a dev install still gets a copy-pasteable snippet
 * instead of a broken `undefined/api/mcp`.
 */
export function resolveMcpEndpoint(headers: Headers | null): string {
  if (headers) {
    const proto = headers.get("x-forwarded-proto") ?? "https";
    const host =
      headers.get("x-forwarded-host") ?? headers.get("host") ?? null;
    if (host) {
      return `${proto}://${host}/api/mcp`;
    }
  }
  const envUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.VERCEL_URL ??
    null;
  if (envUrl) {
    const withProto = envUrl.startsWith("http")
      ? envUrl
      : `https://${envUrl}`;
    return `${withProto.replace(/\/+$/, "")}/api/mcp`;
  }
  return "http://localhost:3000/api/mcp";
}
