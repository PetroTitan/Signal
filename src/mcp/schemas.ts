/**
 * Phase F0 — lightweight input validators for MCP tool arguments.
 *
 * We deliberately avoid a third-party dependency: each tool gets a
 * narrow `parse*` function that returns `{ ok: true, value }` or
 * `{ ok: false, errors }`. The dispatcher converts a fail into an
 * `invalid_arguments` response.
 */

type ParseOk<T> = { ok: true; value: T };
type ParseFail = { ok: false; errors: string[] };
export type Parse<T> = ParseOk<T> | ParseFail;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(value: unknown): value is string {
  return typeof value === "string";
}

function isUuidLike(s: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    s,
  );
}

export function parseEmptyArgs(input: unknown): Parse<Record<string, never>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (isObject(input) && Object.keys(input).length === 0) {
    return { ok: true, value: {} };
  }
  return { ok: false, errors: ["expected_empty_args"] };
}

export interface ProductsPrepareArgs {
  name: string;
  domain?: string | null;
  category?: string | null;
  summary?: string | null;
  source_note?: string | null;
}
export function parseProductsPrepare(input: unknown): Parse<ProductsPrepareArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.name) || input.name.trim().length === 0)
    errors.push("name_required");
  if (input.domain !== undefined && input.domain !== null && !str(input.domain))
    errors.push("domain_must_be_string");
  if (input.category !== undefined && input.category !== null && !str(input.category))
    errors.push("category_must_be_string");
  if (input.summary !== undefined && input.summary !== null && !str(input.summary))
    errors.push("summary_must_be_string");
  if (input.source_note !== undefined && input.source_note !== null && !str(input.source_note))
    errors.push("source_note_must_be_string");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: (input.name as string).trim(),
      domain: input.domain ? String(input.domain).trim() : null,
      category: input.category ? String(input.category).trim() : null,
      summary: input.summary ? String(input.summary).trim() : null,
      source_note: input.source_note ? String(input.source_note).trim() : null,
    },
  };
}

export interface AccountsPrepareArgs {
  platform: "reddit" | "x" | "linkedin" | "google";
  display_name: string;
  handle?: string | null;
  product_id?: string | null;
  source_note?: string | null;
}
export function parseAccountsPrepare(input: unknown): Parse<AccountsPrepareArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.platform)) errors.push("platform_required");
  else if (!["reddit", "x", "linkedin", "google"].includes(input.platform))
    errors.push("platform_unsupported");
  if (!str(input.display_name) || input.display_name.trim().length === 0)
    errors.push("display_name_required");
  if (input.handle !== undefined && input.handle !== null && !str(input.handle))
    errors.push("handle_must_be_string");
  if (input.product_id !== undefined && input.product_id !== null) {
    if (!str(input.product_id) || !isUuidLike(input.product_id))
      errors.push("product_id_invalid");
  }
  if (input.source_note !== undefined && input.source_note !== null && !str(input.source_note))
    errors.push("source_note_must_be_string");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      platform: input.platform as AccountsPrepareArgs["platform"],
      display_name: (input.display_name as string).trim(),
      handle: input.handle ? String(input.handle).trim() : null,
      product_id: input.product_id ? String(input.product_id) : null,
      source_note: input.source_note ? String(input.source_note).trim() : null,
    },
  };
}

export interface WeeklyPlanPrepareItemArgs {
  product_id?: string | null;
  account_id?: string | null;
  platform?: string | null;
  title: string;
  body?: string | null;
  content_type?: string | null;
  scheduled_at?: string | null;
  risk_score?: number | null;
  /**
   * Default false → item lands as `pending_approval` and shows up in
   * /approval-queue. Pass `true` to keep it as `draft` (private holding
   * pen that doesn't appear in the approval queue).
   */
  save_as_draft?: boolean;
}
export function parseWeeklyPlanPrepareItem(
  input: unknown,
): Parse<WeeklyPlanPrepareItemArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.title) || input.title.trim().length === 0)
    errors.push("title_required");
  if (input.product_id !== undefined && input.product_id !== null) {
    if (!str(input.product_id) || !isUuidLike(input.product_id))
      errors.push("product_id_invalid");
  }
  if (input.account_id !== undefined && input.account_id !== null) {
    if (!str(input.account_id) || !isUuidLike(input.account_id))
      errors.push("account_id_invalid");
  }
  if (input.risk_score !== undefined && input.risk_score !== null) {
    if (typeof input.risk_score !== "number" || input.risk_score < 0 || input.risk_score > 100)
      errors.push("risk_score_out_of_range");
  }
  if (
    input.save_as_draft !== undefined &&
    input.save_as_draft !== null &&
    typeof input.save_as_draft !== "boolean"
  ) {
    errors.push("save_as_draft_must_be_boolean");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      product_id: input.product_id ? String(input.product_id) : null,
      account_id: input.account_id ? String(input.account_id) : null,
      platform: input.platform ? String(input.platform) : null,
      title: (input.title as string).trim(),
      body: input.body ? String(input.body) : null,
      content_type: input.content_type ? String(input.content_type) : null,
      scheduled_at: input.scheduled_at ? String(input.scheduled_at) : null,
      risk_score:
        typeof input.risk_score === "number" ? input.risk_score : null,
      save_as_draft:
        typeof input.save_as_draft === "boolean" ? input.save_as_draft : false,
    },
  };
}

export interface ImportsPrepareMappingArgs {
  import_type: "product" | "account";
  raw_text: string;
  extracted_fields?: Record<string, unknown>;
  confidence?: number | null;
  warnings?: string[];
}
export function parseImportsPrepareMapping(
  input: unknown,
): Parse<ImportsPrepareMappingArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (input.import_type !== "product" && input.import_type !== "account")
    errors.push("import_type_invalid");
  if (!str(input.raw_text) || input.raw_text.trim().length === 0)
    errors.push("raw_text_required");
  if (input.extracted_fields !== undefined && !isObject(input.extracted_fields))
    errors.push("extracted_fields_must_be_object");
  if (input.confidence !== undefined && input.confidence !== null) {
    if (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)
      errors.push("confidence_out_of_range");
  }
  if (input.warnings !== undefined) {
    if (!Array.isArray(input.warnings) || !input.warnings.every(str))
      errors.push("warnings_must_be_string_array");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      import_type: input.import_type as "product" | "account",
      raw_text: (input.raw_text as string).trim(),
      extracted_fields: isObject(input.extracted_fields)
        ? input.extracted_fields
        : {},
      confidence:
        typeof input.confidence === "number" ? input.confidence : null,
      warnings: Array.isArray(input.warnings)
        ? (input.warnings as string[])
        : [],
    },
  };
}

export interface ReportsSubmitArgs {
  report_type: string;
  summary: string;
  checks?: Array<{ name: string; status: "pass" | "warning" | "fail"; details?: string[] }>;
  recommended_next_action?: string | null;
}
export function parseReportsSubmit(input: unknown): Parse<ReportsSubmitArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  if (!str(input.report_type)) errors.push("report_type_required");
  if (!str(input.summary) || input.summary.trim().length === 0)
    errors.push("summary_required");
  let checks: ReportsSubmitArgs["checks"] = [];
  if (input.checks !== undefined) {
    if (!Array.isArray(input.checks)) {
      errors.push("checks_must_be_array");
    } else {
      checks = [];
      for (let i = 0; i < input.checks.length; i++) {
        const c = input.checks[i];
        if (!isObject(c) || !str(c.name)) {
          errors.push(`checks[${i}]_invalid`);
          continue;
        }
        if (!str(c.status) || !["pass", "warning", "fail"].includes(c.status)) {
          errors.push(`checks[${i}]_invalid_status`);
          continue;
        }
        let details: string[] | undefined;
        if (c.details !== undefined) {
          if (!Array.isArray(c.details) || !c.details.every(str)) {
            errors.push(`checks[${i}]_invalid_details`);
            continue;
          }
          details = c.details as string[];
        }
        checks.push({
          name: c.name,
          status: c.status as "pass" | "warning" | "fail",
          details,
        });
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      report_type: (input.report_type as string).trim(),
      summary: (input.summary as string).trim(),
      checks,
      recommended_next_action: input.recommended_next_action
        ? String(input.recommended_next_action)
        : null,
    },
  };
}

export interface VerificationRunCheckArgs {
  check_name: string;
}
export function parseVerificationRunCheck(
  input: unknown,
): Parse<VerificationRunCheckArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  if (!str(input.check_name))
    return { ok: false, errors: ["check_name_required"] };
  return { ok: true, value: { check_name: input.check_name } };
}

export interface ExecutionDryRunArgs {
  queue_id?: string | null;
  item_id?: string | null;
}
export function parseExecutionDryRun(input: unknown): Parse<ExecutionDryRunArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  const errors: string[] = [];
  const hasQueue = input.queue_id !== undefined && input.queue_id !== null;
  const hasItem = input.item_id !== undefined && input.item_id !== null;
  if (!hasQueue && !hasItem)
    errors.push("queue_id_or_item_id_required");
  if (hasQueue && (!str(input.queue_id) || !isUuidLike(input.queue_id as string)))
    errors.push("queue_id_invalid");
  if (hasItem && (!str(input.item_id) || !isUuidLike(input.item_id as string)))
    errors.push("item_id_invalid");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      queue_id: hasQueue ? String(input.queue_id) : null,
      item_id: hasItem ? String(input.item_id) : null,
    },
  };
}

export interface ExecutionAuthorizeItemArgs {
  execution_item_id: string;
}
export function parseExecutionAuthorizeItem(
  input: unknown,
): Parse<ExecutionAuthorizeItemArgs> {
  if (!isObject(input)) return { ok: false, errors: ["expected_object"] };
  if (!str(input.execution_item_id) || !isUuidLike(input.execution_item_id))
    return { ok: false, errors: ["execution_item_id_invalid"] };
  return { ok: true, value: { execution_item_id: input.execution_item_id } };
}
