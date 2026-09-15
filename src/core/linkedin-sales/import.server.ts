import "server-only";
/**
 * Importing customer-provided LinkedIn profile URLs.
 *
 * WHAT THIS DOES
 *   Parses a CSV (or pasted lines) the customer already has, normalises
 *   each public profile URL, and records the rows in a lead list. The
 *   suppression list is applied at insertion, inside PostgreSQL.
 *
 * WHAT THIS NEVER DOES
 *   It never requests a profile to check it exists, never reads a
 *   title, photo or headline, never touches LinkedIn at all. The file
 *   is the whole source. A structural test keeps this module free of
 *   any HTTP client.
 *
 * DURABILITY
 *   The file is fingerprinted (SHA-256). One job exists per (list,
 *   fingerprint); re-sending the same file resumes that job from its
 *   cursor instead of starting another. Each chunk of rows is applied
 *   by `linkedin_apply_import_chunk`, which inserts the rows AND moves
 *   the cursor in one transaction, so a retry after a crash cannot
 *   double-count. The file is never held in React state: the browser
 *   posts it, the server parses it, and only the job id goes back.
 *
 * LIMITS
 *   1 MB and 10,000 data rows, checked before any row is written. A
 *   bigger file is refused with the number, not truncated silently.
 */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LinkedInImportJobRow, LinkedInSourceType } from "@/lib/supabase/types";
import {
  applyImportChunk,
  createImportJob,
  findImportJobByFingerprint,
  getImportJob,
  getLeadList,
  markImportJobFailed,
} from "@/repositories/linkedin-sales-repository";
import { detectColumns, isBlankRow, parseCsv } from "./csv";
import { normaliseProfileUrl, REFUSAL_LABELS } from "./profile-url";

export const IMPORT_MAX_BYTES = 1_000_000;
export const IMPORT_MAX_ROWS = 10_000;
export const IMPORT_CHUNK_ROWS = 500;
/** How much of an offending cell the error report keeps. */
export const IMPORT_ERROR_VALUE_MAX = 200;

export type ImportRefusal = "empty" | "too_large" | "too_many_rows" | "no_url_column" | "list_not_found";

export const IMPORT_REFUSAL_LABELS: Record<ImportRefusal, string> = {
  empty: "The file has no rows to import.",
  too_large: "The file is larger than 1 MB. Split it and import the parts.",
  too_many_rows: "The file has more than 10,000 rows. Split it and import the parts.",
  no_url_column: "No column holds LinkedIn profile URLs. Add a header named \"url\" or put the URL in the first column.",
  list_not_found: "That lead list does not exist in this workspace.",
};

export interface ImportRequest {
  workspaceId: string;
  leadListId: string;
  sourceType: LinkedInSourceType;
  /** The file's text. Already in memory on the server; never sent back. */
  text: string;
  fileName?: string | null;
  createdBy?: string | null;
  db?: SupabaseClient;
  /** Stop after this many chunks (tests of resumption). Default: all. */
  maxChunks?: number;
}

export type ImportOutcome =
  | {
      ok: true;
      job: LinkedInImportJobRow;
      /** True when an earlier job for the same file was continued. */
      resumed: boolean;
      /** True when the file had already been fully imported before this call. */
      alreadyImported: boolean;
      finished: boolean;
      chunksApplied: number;
    }
  | { ok: false; reason: ImportRefusal; detail: string };

export function fingerprintText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

interface ChunkRow {
  profile_key: string;
  canonical_profile_url: string;
  name: string | null;
  company: string | null;
  title: string | null;
}

interface ReportLine {
  row: number;
  value: string;
  reason: string;
}

const cell = (row: string[], index: number | null): string | null => {
  if (index === null) return null;
  const v = (row[index] ?? "").trim();
  return v.length === 0 ? null : v.slice(0, 200);
};

export async function importLeadsFromText(input: ImportRequest): Promise<ImportOutcome> {
  const text = input.text ?? "";
  if (text.trim().length === 0) {
    return { ok: false, reason: "empty", detail: IMPORT_REFUSAL_LABELS.empty };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > IMPORT_MAX_BYTES) {
    return { ok: false, reason: "too_large", detail: `${bytes.toLocaleString("en-GB")} bytes; the limit is ${IMPORT_MAX_BYTES.toLocaleString("en-GB")}.` };
  }

  const list = await getLeadList({ workspaceId: input.workspaceId, leadListId: input.leadListId, db: input.db });
  if (!list) return { ok: false, reason: "list_not_found", detail: IMPORT_REFUSAL_LABELS.list_not_found };

  const parsed = parseCsv(text);
  const columns = detectColumns(parsed.rows);
  if (!columns) return { ok: false, reason: "no_url_column", detail: IMPORT_REFUSAL_LABELS.no_url_column };

  const firstNonBlank = parsed.rows.findIndex((r) => !isBlankRow(r));
  const start = columns.hasHeader ? firstNonBlank + 1 : firstNonBlank;
  let dataRows = 0;
  for (let i = start; i < parsed.rows.length; i += 1) if (!isBlankRow(parsed.rows[i])) dataRows += 1;
  if (dataRows === 0) return { ok: false, reason: "empty", detail: IMPORT_REFUSAL_LABELS.empty };
  if (dataRows > IMPORT_MAX_ROWS) {
    return { ok: false, reason: "too_many_rows", detail: `${dataRows.toLocaleString("en-GB")} rows; the limit is ${IMPORT_MAX_ROWS.toLocaleString("en-GB")}.` };
  }

  const fingerprint = fingerprintText(text);
  const existing = await findImportJobByFingerprint({
    workspaceId: input.workspaceId, leadListId: input.leadListId, fingerprint, db: input.db,
  });
  if (existing?.status === "ready") {
    return { ok: true, job: existing, resumed: false, alreadyImported: true, finished: true, chunksApplied: 0 };
  }
  const job = existing ?? (await createImportJob({
    workspaceId: input.workspaceId,
    leadListId: input.leadListId,
    sourceType: input.sourceType,
    fileName: input.fileName ?? null,
    fingerprint,
    totalRows: dataRows,
    createdBy: input.createdBy ?? null,
    db: input.db,
  }));

  const maxChunks = input.maxChunks ?? Number.POSITIVE_INFINITY;
  let cursor = Math.max(job.cursor_row, start);
  let chunksApplied = 0;
  const seenInRun = new Set<string>();

  try {
    while (cursor < parsed.rows.length && chunksApplied < maxChunks) {
      const end = Math.min(cursor + IMPORT_CHUNK_ROWS, parsed.rows.length);
      const rows: ChunkRow[] = [];
      const errors: ReportLine[] = [];
      let invalid = 0;

      for (let i = cursor; i < end; i += 1) {
        const row = parsed.rows[i];
        if (isBlankRow(row)) continue;
        const raw = (row[columns.url] ?? "").trim();
        const result = normaliseProfileUrl(raw);
        if (!result.ok) {
          invalid += 1;
          errors.push({ row: i + 1, value: raw.slice(0, IMPORT_ERROR_VALUE_MAX), reason: REFUSAL_LABELS[result.reason] });
          continue;
        }
        if (seenInRun.has(result.profileKey)) {
          // Sent anyway: PostgreSQL counts it as a duplicate on conflict.
          // The report line is for the operator, who sees the file.
          errors.push({ row: i + 1, value: raw.slice(0, IMPORT_ERROR_VALUE_MAX), reason: "Duplicate of an earlier row in this file." });
        }
        seenInRun.add(result.profileKey);
        rows.push({
          profile_key: result.profileKey,
          canonical_profile_url: result.canonicalUrl,
          name: cell(row, columns.name),
          company: cell(row, columns.company),
          title: cell(row, columns.title),
        });
      }

      const done = end >= parsed.rows.length;
      const applied = await applyImportChunk({
        workspaceId: input.workspaceId,
        jobId: job.id,
        rows,
        nextCursorRow: end,
        invalid,
        errors,
        done,
        db: input.db,
      });
      cursor = Math.max(end, applied.nextCursorRow);
      chunksApplied += 1;
    }
  } catch (err) {
    await markImportJobFailed({
      workspaceId: input.workspaceId,
      jobId: job.id,
      message: err instanceof Error ? err.message : "Import failed.",
      db: input.db,
    }).catch(() => undefined);
    throw err;
  }

  const final = (await getImportJob({ workspaceId: input.workspaceId, jobId: job.id, db: input.db })) ?? job;
  return {
    ok: true,
    job: final,
    resumed: existing !== null,
    alreadyImported: false,
    finished: final.status === "ready",
    chunksApplied,
  };
}
