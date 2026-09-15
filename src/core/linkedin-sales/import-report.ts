/**
 * The exportable error report of an import job, as CSV.
 *
 * Pure and client-safe. One line per row the importer could not use,
 * with the row number in the operator's file, the offending value
 * (truncated by the importer) and the reason in plain words.
 */

import type { LinkedInImportJobRow } from "@/lib/supabase/types";

const quote = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function importErrorReportCsv(job: Pick<LinkedInImportJobRow, "error_report">): string {
  const lines = ["row,value,reason"];
  for (const e of job.error_report ?? []) {
    lines.push([quote(e.row), quote(e.value ?? ""), quote(e.reason ?? "")].join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export interface ImportCounts {
  inserted: number;
  duplicates: number;
  invalid: number;
  suppressed: number;
}

/** inserted + duplicates + invalid + suppressed. Equals the file's non-blank data rows when the job is ready. */
export function importCountsTotal(c: ImportCounts): number {
  return c.inserted + c.duplicates + c.invalid + c.suppressed;
}
