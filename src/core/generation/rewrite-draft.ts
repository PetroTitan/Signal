import "server-only";
/**
 * Phase F4.6 — rewrite-draft entry point.
 *
 * Loads the publishing identity context, builds the rewrite prompt,
 * calls the provider, re-checks safety, and returns the rewritten
 * body (or refuses cleanly).
 *
 * Failure paths are explicit: no_credentials, provider_error,
 * provider_refused (safety), empty_response, no_body. The caller
 * (rewriteDraftAction) maps each to founder-readable copy via
 * friendlyGenerationFailure.
 *
 * Never logs prompts. Never logs provider output. Never stores
 * tokens, raw response payloads, or chain-of-thought.
 */

import { getPublishingIdentityContext } from "@/core/publishing/publishing-identity-context";
import { buildRewritePrompt } from "./rewrite-builder";
import { evaluateDraftSafety } from "./safety-rules";
import { callGenerationProvider } from "./providers";
import type { GenerationProviderName } from "./providers/normalize-response";
import type { RewriteAction } from "./rewrite-types";

export interface RewriteDraftInput {
  workspaceId: string;
  identityId: string;
  itemId: string;
  currentTitle: string | null;
  currentBody: string;
  platform: string;
  action: RewriteAction;
}

export type RewriteDraftResult =
  | {
      ok: true;
      action: RewriteAction;
      providerName: GenerationProviderName;
      durationMs: number;
      truncated: boolean;
      /** When the action is "improve_headline" this is the new title; body untouched. */
      newTitle: string | null;
      /** When the action affects body, this is the new body. */
      newBody: string | null;
      /** Carries safety notes from the re-check (always empty on ok=true). */
      safetyNotes: string[];
    }
  | {
      ok: false;
      reason:
        | "no_body"
        | "no_provider_configured"
        | "provider_unavailable"
        | "provider_refused"
        | "empty_response";
      detail: string;
      safetyNotes: string[];
      durationMs?: number;
    };

export async function rewriteDraft(
  input: RewriteDraftInput,
): Promise<RewriteDraftResult> {
  if (!input.currentBody || input.currentBody.trim().length === 0) {
    return {
      ok: false,
      reason: "no_body",
      detail: "Write something first — there's no draft to rewrite yet.",
      safetyNotes: [],
    };
  }

  const identityContext = await getPublishingIdentityContext({
    workspaceId: input.workspaceId,
    identityId: input.identityId,
    historyLimit: 5,
  });
  if (!identityContext) {
    return {
      ok: false,
      reason: "provider_unavailable",
      detail: "Couldn't find this publishing identity.",
      safetyNotes: [],
    };
  }

  const prompt = buildRewritePrompt({
    identityContext,
    currentTitle: input.currentTitle,
    currentBody: input.currentBody,
    platform: input.platform,
    action: input.action,
  });

  const response = await callGenerationProvider({
    system: prompt.system,
    user: prompt.user,
    // Headline rewrites only need a small budget; full rewrites get the default.
    maxOutputTokens: prompt.expectsHeadlineOnly ? 200 : 4096,
  });

  if (!response.ok) {
    const reason =
      response.reason === "no_credentials" ||
      response.reason === "no_provider_configured"
        ? "no_provider_configured"
        : "provider_unavailable";
    return {
      ok: false,
      reason,
      detail: response.detail,
      safetyNotes: [],
      durationMs: response.durationMs,
    };
  }

  // For headline-only rewrites, take the first non-empty line.
  if (prompt.expectsHeadlineOnly) {
    const headline = extractFirstLine(response.text);
    if (!headline) {
      return {
        ok: false,
        reason: "empty_response",
        detail: "The provider didn't return a headline.",
        safetyNotes: [],
        durationMs: response.durationMs,
      };
    }
    const verdict = evaluateDraftSafety({
      title: headline,
      body: input.currentBody,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        reason: "provider_refused",
        detail: friendlySafetyRefusalDetail(verdict.violations),
        safetyNotes: verdict.violations,
        durationMs: response.durationMs,
      };
    }
    return {
      ok: true,
      action: input.action,
      providerName: response.providerName,
      durationMs: response.durationMs,
      truncated: response.truncated,
      newTitle: headline,
      newBody: null,
      safetyNotes: [],
    };
  }

  // Body rewrites — strip any leading "Here is" / preamble lines if
  // the model included them anyway, then run safety.
  const newBody = stripPreamble(response.text);
  if (newBody.length === 0) {
    return {
      ok: false,
      reason: "empty_response",
      detail: "The provider returned an empty rewrite.",
      safetyNotes: [],
      durationMs: response.durationMs,
    };
  }
  const verdict = evaluateDraftSafety({
    title: input.currentTitle,
    body: newBody,
  });
  if (!verdict.ok) {
    return {
      ok: false,
      reason: "provider_refused",
      detail: friendlySafetyRefusalDetail(verdict.violations),
      safetyNotes: verdict.violations,
      durationMs: response.durationMs,
    };
  }

  return {
    ok: true,
    action: input.action,
    providerName: response.providerName,
    durationMs: response.durationMs,
    truncated: response.truncated,
    newTitle: null,
    newBody,
    safetyNotes: [],
  };
}

function extractFirstLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^#+\s*/, "").replace(/^["'`]|["'`]$/g, "");
    if (line.length > 0) return line.slice(0, 280);
  }
  return null;
}

function stripPreamble(text: string): string {
  // Some providers persist on adding "Here's the rewrite:" or similar.
  // Drop a leading short paragraph that ends in ':' and is itself
  // short — only when followed by a clearly larger body.
  const trimmed = text.trim();
  const m = trimmed.match(
    /^(here(?:'s| is)(?: the)?[^\n]{0,80}:\s*\n+)([\s\S]+)$/i,
  );
  if (m) return m[2].trim();
  return trimmed;
}

function friendlySafetyRefusalDetail(violations: string[]): string {
  if (violations.length === 0) {
    return "The rewrite tripped a safety rule. Try editing manually.";
  }
  return `The rewrite tripped a safety rule (${violations[0]}). Try editing manually or pick a different action.`;
}
