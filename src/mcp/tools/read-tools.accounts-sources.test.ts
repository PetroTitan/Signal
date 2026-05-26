import { describe, expect, it, vi } from "vitest";
import { accountsList } from "./read-tools";
import type { ToolContext } from "../tool-context";

/**
 * Phase F7.2 — MCP `signal.accounts.list` must include the
 * identity-level factual-source fields (`source_website_url` +
 * `reference_urls`) introduced in PR #117.
 *
 * Codex generation flows read these to confirm the canonical
 * source before drafting a post. The previous projection omitted
 * the two columns; this test pins the fix and asserts no
 * secret-shaped column slips into the projection.
 */

function mockCtx(rows: Array<Record<string, unknown>>): ToolContext {
  // Capture the SELECT columns string the handler asks Supabase
  // for. The test asserts the columns set explicitly.
  let capturedSelect = "";
  const ctx: ToolContext = {
    workspaceId: "ws-1",
    operatorTokenId: "tok-1",
    scopes: ["accounts:read"],
    token: { id: "tok-1" } as never,
    db: {
      from: () => ({
        select: (cols: string) => {
          capturedSelect = cols;
          return {
            eq: () => ({
              order: () => ({
                limit: async () => ({ data: rows, error: null }),
              }),
            }),
          };
        },
      }),
    } as never,
  };
  // Stash the capturer on the ctx so the test can grep it.
  (ctx as unknown as { __capturedSelect: () => string }).__capturedSelect =
    () => capturedSelect;
  return ctx;
}

describe("signal.accounts.list — projects identity source fields", () => {
  it("SELECT includes source_website_url and reference_urls", async () => {
    const ctx = mockCtx([]);
    await accountsList(ctx);
    const cols = (
      ctx as unknown as { __capturedSelect: () => string }
    ).__capturedSelect();
    expect(cols).toContain("source_website_url");
    expect(cols).toContain("reference_urls");
  });

  it("SELECT does NOT include token / secret columns", async () => {
    const ctx = mockCtx([]);
    await accountsList(ctx);
    const cols = (
      ctx as unknown as { __capturedSelect: () => string }
    ).__capturedSelect();
    // growth_accounts has no tokens, but defense-in-depth: any
    // future audit that adds an encrypted column should NOT be
    // surfaced by this read tool. These names match the pattern
    // used elsewhere in the codebase.
    expect(cols).not.toMatch(/access_token/);
    expect(cols).not.toMatch(/refresh_token/);
    expect(cols).not.toMatch(/api_key/);
  });

  it("response body carries source_website_url + reference_urls per account", async () => {
    const ctx = mockCtx([
      {
        id: "a-1",
        platform: "devto",
        handle: "petro",
        source_website_url: "https://www.webmasterid.com",
        reference_urls: ["https://models.webmasterid.com"],
      },
      {
        id: "a-2",
        platform: "bluesky",
        handle: "petro.bsky.social",
        source_website_url: null,
        reference_urls: [],
      },
    ]);
    const out = await accountsList(ctx);
    expect(out.ok).toBe(true);
    const accounts = (out.data.accounts as Array<Record<string, unknown>>) ?? [];
    expect(accounts).toHaveLength(2);
    expect(accounts[0].source_website_url).toBe("https://www.webmasterid.com");
    expect(accounts[0].reference_urls).toEqual([
      "https://models.webmasterid.com",
    ]);
    expect(accounts[1].source_website_url).toBeNull();
    expect(accounts[1].reference_urls).toEqual([]);
  });

  it("workspace filter still applied (no cross-workspace leak)", async () => {
    let capturedWorkspace = "";
    const ctx: ToolContext = {
      workspaceId: "ws-1",
      operatorTokenId: "tok-1",
      scopes: ["accounts:read"],
      token: { id: "tok-1" } as never,
      db: {
        from: () => ({
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === "workspace_id") capturedWorkspace = val;
              return {
                order: () => ({
                  limit: async () => ({ data: [], error: null }),
                }),
              };
            },
          }),
        }),
      } as never,
    };
    await accountsList(ctx);
    expect(capturedWorkspace).toBe("ws-1");
  });
});

// Silences "vi imported but unused" when no spies are used in this file.
void vi;
