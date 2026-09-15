import { describe, expect, it } from "vitest";
import { detectColumns, isBlankRow, parseCsv, rowsBetween } from "./csv";

describe("parseCsv", () => {
  it("handles a BOM, CRLF, quoted commas, escaped quotes and embedded newlines", () => {
    const text = '﻿url,name\r\n"https://www.linkedin.com/in/a","Doe, Jane"\r\n"https://www.linkedin.com/in/b","She said ""hi"""\r\n"https://www.linkedin.com/in/c","Line one\nLine two"\r\n';
    const p = parseCsv(text);
    expect(p.hadBom).toBe(true);
    expect(p.rows).toEqual([
      ["url", "name"],
      ["https://www.linkedin.com/in/a", "Doe, Jane"],
      ["https://www.linkedin.com/in/b", 'She said "hi"'],
      ["https://www.linkedin.com/in/c", "Line one\nLine two"],
    ]);
  });

  it("keeps empty rows so row numbers match the file, and reports blank rows", () => {
    const p = parseCsv("a,b\n\n,\nc,d");
    expect(p.rows).toEqual([["a", "b"], [""], ["", ""], ["c", "d"]]);
    expect(p.rows.map(isBlankRow)).toEqual([false, true, true, false]);
  });

  it("does not throw on malformed input: an unterminated quote closes at end of file", () => {
    const p = parseCsv('url\n"https://www.linkedin.com/in/x,y');
    expect(p.rows).toEqual([["url"], ["https://www.linkedin.com/in/x,y"]]);
  });

  it("treats a quote in the middle of a cell as literal", () => {
    expect(parseCsv('ab"c,d').rows).toEqual([['ab"c', "d"]]);
  });

  it("handles a file without a trailing newline and LF-only endings", () => {
    expect(parseCsv("a,b\nc,d").rows).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("parses 50,000 rows in one pass without quadratic behaviour", () => {
    const text = Array.from({ length: 50_000 }, (_, i) => `https://www.linkedin.com/in/person-${i},"Name ${i}"`).join("\n");
    const started = Date.now();
    const p = parseCsv(text);
    expect(p.rows).toHaveLength(50_000);
    expect(p.rows[49_999][1]).toBe("Name 49999");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("detectColumns", () => {
  it("uses a header row when one names the URL column, in any case, with a BOM", () => {
    const p = parseCsv("﻿Name,LinkedIn URL,Company,Job Title\nJane,https://www.linkedin.com/in/j,Acme,CTO");
    expect(detectColumns(p.rows)).toEqual({ url: 1, name: 0, company: 2, title: 3, hasHeader: true });
  });

  it("without a header, picks the first column that looks like a LinkedIn URL", () => {
    const p = parseCsv("Jane,https://www.linkedin.com/in/j\nJohn,https://www.linkedin.com/in/k");
    expect(detectColumns(p.rows)).toEqual({ url: 1, name: null, company: null, title: null, hasHeader: false });
  });

  it("returns null when no column can be a URL, so nothing is guessed", () => {
    expect(detectColumns(parseCsv("a,b\nc,d").rows)).toBeNull();
    expect(detectColumns(parseCsv("").rows)).toBeNull();
    expect(detectColumns(parseCsv("\n\n").rows)).toBeNull();
  });

  it("skips leading blank rows before deciding", () => {
    const p = parseCsv("\n\nurl\nhttps://www.linkedin.com/in/x");
    expect(detectColumns(p.rows)?.url).toBe(0);
  });
});

describe("rowsBetween", () => {
  it("slices by row number for a cursor-driven importer", () => {
    const p = parseCsv("a\nb\nc\nd");
    expect(rowsBetween(p, 1, 3)).toEqual([["b"], ["c"]]);
    expect(rowsBetween(p, 3, 99)).toEqual([["d"]]);
    expect(rowsBetween(p, 5, 9)).toEqual([]);
  });
});
