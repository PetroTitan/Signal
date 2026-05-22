/**
 * Phase E2.8 — pure validator for the result envelope JSON.
 *
 * Returns a structured outcome the caller can persist. Never throws.
 */

import type {
  BridgeAssistantType,
  BridgeResultEnvelope,
  BridgeResultCheck,
} from "./bridge-types";
import { BRIDGE_ASSISTANT_TYPES } from "./bridge-types";
import {
  BRIDGE_MAX_RESULT_BYTES,
  BRIDGE_MAX_SUMMARY_CHARS,
  FORBIDDEN_RESULT_FIELDS,
} from "./bridge-policy";

export interface SchemaValidationOk {
  ok: true;
  envelope: BridgeResultEnvelope;
}
export interface SchemaValidationFail {
  ok: false;
  errors: string[];
}
export type SchemaValidation = SchemaValidationOk | SchemaValidationFail;

const RESULT_STATUSES = new Set(["completed", "failed", "needs_review"]);
const CHECK_STATUSES = new Set(["pass", "warning", "fail"]);

function isStringValue(v: unknown): v is string {
  return typeof v === "string";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse a raw string into a result envelope. Performs:
 *
 *   - JSON.parse
 *   - top-level shape check (request_id, nonce, assistant_type,
 *     status, summary, checks, requires_user_approval)
 *   - per-check shape check
 *   - byte-size limit
 *   - summary length limit
 *   - forbidden-fields scan over the entire payload
 */
export function parseResultEnvelope(raw: string): SchemaValidation {
  const errors: string[] = [];

  if (raw.length > BRIDGE_MAX_RESULT_BYTES * 2) {
    return { ok: false, errors: ["result_too_large"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["invalid_json"] };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["envelope_not_object"] };
  }

  const env = parsed as Record<string, unknown>;

  if (!isStringValue(env.request_id) || env.request_id.length === 0) {
    errors.push("missing_request_id");
  }
  if (!isStringValue(env.nonce) || env.nonce.length === 0) {
    errors.push("missing_nonce");
  }
  if (
    !isStringValue(env.assistant_type) ||
    !BRIDGE_ASSISTANT_TYPES.includes(env.assistant_type as BridgeAssistantType)
  ) {
    errors.push("invalid_assistant_type");
  }
  if (!isStringValue(env.status) || !RESULT_STATUSES.has(env.status)) {
    errors.push("invalid_status");
  }
  if (
    !isStringValue(env.summary) ||
    env.summary.length === 0 ||
    env.summary.length > BRIDGE_MAX_SUMMARY_CHARS
  ) {
    errors.push("invalid_summary");
  }
  if (typeof env.requires_user_approval !== "boolean") {
    errors.push("invalid_requires_user_approval");
  }
  if (!Array.isArray(env.checks)) {
    errors.push("checks_not_array");
  }

  const checks: BridgeResultCheck[] = [];
  if (Array.isArray(env.checks)) {
    for (let i = 0; i < env.checks.length; i++) {
      const c = env.checks[i];
      if (!isPlainObject(c)) {
        errors.push(`checks[${i}]_not_object`);
        continue;
      }
      if (!isStringValue(c.name)) {
        errors.push(`checks[${i}]_missing_name`);
        continue;
      }
      if (!isStringValue(c.status) || !CHECK_STATUSES.has(c.status)) {
        errors.push(`checks[${i}]_invalid_status`);
        continue;
      }
      const detailsValue = c.details;
      let details: string[] | undefined;
      if (detailsValue !== undefined) {
        if (
          !Array.isArray(detailsValue) ||
          !detailsValue.every((d) => typeof d === "string")
        ) {
          errors.push(`checks[${i}]_invalid_details`);
          continue;
        }
        details = detailsValue as string[];
      }
      checks.push({
        name: c.name,
        status: c.status as BridgeResultCheck["status"],
        details,
      });
    }
  }

  // Forbidden-fields scan.
  const forbidden = scanForForbiddenFields(env);
  for (const path of forbidden) {
    errors.push(`forbidden_field:${path}`);
  }

  // Approximate byte limit on the parsed envelope (already JSON, so
  // re-serializing gives a tight bound).
  try {
    const reSerialized = JSON.stringify(env);
    if (reSerialized.length > BRIDGE_MAX_RESULT_BYTES) {
      errors.push("result_too_large");
    }
  } catch {
    errors.push("result_not_serializable");
  }

  if (errors.length > 0) return { ok: false, errors };

  const envelope: BridgeResultEnvelope = {
    request_id: env.request_id as string,
    nonce: env.nonce as string,
    assistant_type: env.assistant_type as BridgeAssistantType,
    status: env.status as BridgeResultEnvelope["status"],
    summary: env.summary as string,
    checks,
    requires_user_approval: env.requires_user_approval as boolean,
  };
  if (env.recommended_next_action && isStringValue(env.recommended_next_action)) {
    envelope.recommended_next_action = env.recommended_next_action;
  }
  if (Array.isArray(env.artifacts)) {
    envelope.artifacts = env.artifacts
      .filter(isPlainObject)
      .map((a) => ({
        kind: isStringValue(a.kind) ? a.kind : "unknown",
        label: isStringValue(a.label) ? a.label : "(no label)",
        body: isStringValue(a.body) ? a.body : undefined,
      }));
  }
  return { ok: true, envelope };
}

/**
 * Walk the JSON tree and collect dotted paths of any key that contains
 * a forbidden token. Case-insensitive.
 */
export function scanForForbiddenFields(value: unknown, prefix = ""): string[] {
  const hits: string[] = [];
  function isHit(key: string): boolean {
    const lower = key.toLowerCase();
    return FORBIDDEN_RESULT_FIELDS.some((f) => lower.includes(f));
  }
  function walk(node: unknown, path: string) {
    if (Array.isArray(node)) {
      node.forEach((child, idx) => walk(child, `${path}[${idx}]`));
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        const childPath = path ? `${path}.${key}` : key;
        if (isHit(key)) {
          hits.push(childPath);
        }
        walk(child, childPath);
      }
    }
  }
  walk(value, prefix);
  return hits;
}
