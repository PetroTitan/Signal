/**
 * CSV parsing for customer-provided lead files.
 *
 * RFC 4180 with the accommodations real files need: a UTF-8 BOM, CRLF
 * or LF line endings, quoted cells containing commas, quotes ("") and
 * newlines, ragged rows, and blank lines. Pure and streaming-friendly:
 * `parseCsv` walks the text once and never builds anything but the
 * rows it returns, and `rowsBetween` lets an importer take a slice
 * without re-parsing what it already handled.
 *
 * It does not guess encodings beyond the BOM, does not trim cells
 * (callers decide), and never throws on malformed input: an unbalanced
 * quote at end of file closes the last cell, and the caller sees the
 * row as it was.
 */

export interface ParsedCsv {
  /** Every row, including empty ones (so row numbers match the file). */
  rows: string[][];
  /** True when the file began with a UTF-8 byte order mark. */
  hadBom: boolean;
}

export function parseCsv(text: string): ParsedCsv {
  let i = 0;
  let hadBom = false;
  if (text.charCodeAt(0) === 0xfeff) {
    i = 1;
    hadBom = true;
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A quote opens a quoted cell only at the start of the cell;
      // elsewhere it is literal (lenient, like spreadsheets export).
      if (cell.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  // Last line without a terminator.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, hadBom };
}

export function isBlankRow(row: string[]): boolean {
  return row.every((c) => c.trim().length === 0);
}

/** Column roles the importer understands. */
export interface CsvColumnMap {
  url: number;
  name: number | null;
  company: number | null;
  title: number | null;
  /** True when the first row was a header and must be skipped. */
  hasHeader: boolean;
}

const URL_HEADERS = ["url", "linkedin", "linkedin url", "linkedin_url", "profile", "profile url", "profile_url", "link"];
const NAME_HEADERS = ["name", "full name", "full_name", "first name"];
const COMPANY_HEADERS = ["company", "organisation", "organization", "employer"];
const TITLE_HEADERS = ["title", "job title", "job_title", "role", "position"];

const norm = (s: string) => s.replace(/^﻿/, "").trim().toLowerCase();

/**
 * Decide which column holds the URL. A header row wins when present;
 * otherwise the first column whose first non-blank value looks like a
 * LinkedIn URL. Returns null when no column can be the URL — the
 * importer then reports every row as invalid rather than guessing.
 */
export function detectColumns(rows: string[][]): CsvColumnMap | null {
  const first = rows.find((r) => !isBlankRow(r));
  if (!first) return null;
  const headers = first.map(norm);
  const find = (candidates: string[]) => {
    const idx = headers.findIndex((h) => candidates.includes(h));
    return idx === -1 ? null : idx;
  };
  const urlByHeader = find(URL_HEADERS);
  if (urlByHeader !== null) {
    return {
      url: urlByHeader,
      name: find(NAME_HEADERS),
      company: find(COMPANY_HEADERS),
      title: find(TITLE_HEADERS),
      hasHeader: true,
    };
  }
  // No header: the first column that looks like a LinkedIn URL.
  const looksLikeUrl = (v: string) => /linkedin\.com\//i.test(v);
  for (let col = 0; col < first.length; col += 1) {
    if (looksLikeUrl(first[col] ?? "")) {
      return { url: col, name: null, company: null, title: null, hasHeader: false };
    }
  }
  return null;
}

/** The rows in [from, to), for a resumable importer working from a cursor. */
export function rowsBetween(parsed: ParsedCsv, from: number, to: number): string[][] {
  return parsed.rows.slice(Math.max(0, from), Math.max(from, to));
}
