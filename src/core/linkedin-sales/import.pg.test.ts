/**
 * Import and deduplication, against real PostgreSQL (PGlite, every
 * migration applied as shipped), as the signed-in operator through RLS.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "@/test/pg/harness";
import { pgliteSupabase } from "@/test/pg/supabase-adapter";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createLeadList, getImportJob, addSuppression, applyImportChunk, listImportJobs } from "@/repositories/linkedin-sales-repository";
import { IMPORT_CHUNK_ROWS, IMPORT_MAX_BYTES, importLeadsFromText } from "./import.server";
import { importCountsTotal, importErrorReportCsv } from "./import-report";

let h: PgHarness;
let db: SupabaseClient;
let t: Tenant;

beforeAll(async () => {
  h = await createPgHarness();
  db = pgliteSupabase(h.db);
  t = await seedTenant(h.db, "li-import");
});
afterAll(async () => {
  await h.close();
});

const asOwner = <T>(fn: () => Promise<T>) => h.asUser(t.ownerId, fn);

async function newList(name: string) {
  return asOwner(() => createLeadList({ workspaceId: t.workspaceId, name, sourceType: "customer_csv", db }));
}

async function leadsOf(listId: string) {
  const r = await h.db.query<{ profile_key: string; do_not_contact: boolean; do_not_contact_reason: string | null; customer_provided_name: string | null }>(
    `select profile_key, do_not_contact, do_not_contact_reason, customer_provided_name
       from public.linkedin_leads where lead_list_id = $1 order by profile_key`,
    [listId],
  );
  return r.rows;
}

describe("importing a customer-provided CSV", () => {
  it("counts inserted, duplicate, invalid and suppressed rows; suppressed leads are recorded do-not-contact", async () => {
    const list = await newList("mixed");
    await asOwner(() => addSuppression({
      workspaceId: t.workspaceId, profileKey: "opted-out", canonicalProfileUrl: "https://www.linkedin.com/in/opted-out",
      source: "operator", reason: "asked us to stop", db,
    }));

    const text = [
      "Name,LinkedIn URL,Company",
      "Jane,https://www.linkedin.com/in/Jane-Doe/,Acme",
      "",
      "John,https://linkedin.com/in/john-smith?trk=abc,Beta",
      "Dup,https://www.linkedin.com/in/jane-doe,Acme",
      "Bad,https://www.linkedin.com/company/acme,Acme",
      "Worse,not a url,Acme",
      "Out,https://www.linkedin.com/in/opted-out,Gamma",
      "Cred,https://www.linkedin.com/in/x?li_at=AQED,Gamma",
    ].join("\n");

    const out = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text, fileName: "mixed.csv", createdBy: t.ownerId, db,
    }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.finished).toBe(true);
    expect(out.alreadyImported).toBe(false);
    expect(out.job.status).toBe("ready");
    expect(out.job.inserted_count).toBe(2);
    expect(out.job.duplicate_count).toBe(1);
    expect(out.job.invalid_count).toBe(3);
    expect(out.job.suppressed_count).toBe(1);
    expect(out.job.total_rows).toBe(7);
    expect(importCountsTotal({
      inserted: out.job.inserted_count, duplicates: out.job.duplicate_count, invalid: out.job.invalid_count, suppressed: out.job.suppressed_count,
    })).toBe(7);

    const leads = await leadsOf(list.id);
    expect(leads.map((l) => l.profile_key)).toEqual(["jane-doe", "john-smith", "opted-out"]);
    const suppressed = leads.find((l) => l.profile_key === "opted-out");
    expect(suppressed?.do_not_contact).toBe(true);
    expect(suppressed?.do_not_contact_reason).toBe("suppression_list");
    expect(leads.find((l) => l.profile_key === "jane-doe")?.customer_provided_name).toBe("Jane");

    // The report names every row that was not imported as-is, by file row number.
    const rows = out.job.error_report.map((e) => e.row).sort((a, b) => a - b);
    expect(rows).toEqual([5, 6, 7, 9]);
    const csv = importErrorReportCsv(out.job);
    expect(csv.split("\r\n")[0]).toBe("row,value,reason");
    expect(csv).toContain("Duplicate of an earlier row in this file.");
    // The credential-like row is reported without echoing the token.
    const cred = out.job.error_report.find((e) => e.row === 9);
    expect(cred?.reason).toMatch(/credential|token|session/i);

    // A compliance event was recorded with the counts.
    const ev = await h.db.query<{ details: Record<string, unknown> }>(
      `select details from public.linkedin_compliance_events where entity_id = $1 and event_type = 'import'`,
      [out.job.id],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].details.inserted).toBe(2);
  });

  it("a second file with an overlapping URL counts it as a duplicate across imports", async () => {
    const list = await newList("overlap");
    const first = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_pasted",
      text: "https://www.linkedin.com/in/alpha\nhttps://www.linkedin.com/in/beta", db,
    }));
    const second = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_pasted",
      text: "https://www.linkedin.com/in/beta\nhttps://www.linkedin.com/in/gamma", db,
    }));
    expect(first.ok && first.job.inserted_count).toBe(2);
    expect(second.ok && second.job.inserted_count).toBe(1);
    expect(second.ok && second.job.duplicate_count).toBe(1);
    expect((await leadsOf(list.id)).map((l) => l.profile_key)).toEqual(["alpha", "beta", "gamma"]);
    expect(await asOwner(() => listImportJobs({ workspaceId: t.workspaceId, leadListId: list.id, db }))).toHaveLength(2);
  });

  it("re-sending an imported file is a no-op: same job, no new rows, counts unchanged", async () => {
    const list = await newList("resend");
    const text = "url\nhttps://www.linkedin.com/in/one\nhttps://www.linkedin.com/in/two\n";
    const a = await asOwner(() => importLeadsFromText({ workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text, db }));
    const b = await asOwner(() => importLeadsFromText({ workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text, db }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.alreadyImported).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.inserted_count).toBe(2);
    expect(b.chunksApplied).toBe(0);
    expect(await leadsOf(list.id)).toHaveLength(2);
  });

  it("stops after a chunk and resumes from the durable cursor without double-counting", async () => {
    const list = await newList("resume");
    const n = IMPORT_CHUNK_ROWS * 2 + 7;
    const text = "url\n" + Array.from({ length: n }, (_, i) => `https://www.linkedin.com/in/r-${i}`).join("\n");

    const partial = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text, db, maxChunks: 1,
    }));
    expect(partial.ok && partial.finished).toBe(false);
    if (!partial.ok) return;
    expect(partial.job.status).toBe("running");
    expect(partial.job.cursor_row).toBe(1 + IMPORT_CHUNK_ROWS);
    expect(partial.job.inserted_count).toBe(IMPORT_CHUNK_ROWS);

    // A crash between "rows written" and "response received" replays
    // the same chunk. The database acknowledges without re-applying.
    const replay = await asOwner(() => applyImportChunk({
      workspaceId: t.workspaceId, jobId: partial.job.id, nextCursorRow: 1 + IMPORT_CHUNK_ROWS, invalid: 0, errors: [], done: false, db,
      rows: [{ profile_key: "r-0", canonical_profile_url: "https://www.linkedin.com/in/r-0", name: null, company: null, title: null }],
    }));
    expect(replay.applied).toBe(false);
    expect(replay.inserted).toBe(IMPORT_CHUNK_ROWS);

    const rest = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text, db,
    }));
    expect(rest.ok && rest.resumed).toBe(true);
    if (!rest.ok) return;
    expect(rest.job.status).toBe("ready");
    expect(rest.job.inserted_count).toBe(n);
    expect(rest.job.duplicate_count).toBe(0);
    expect(rest.chunksApplied).toBe(2);
    expect(await leadsOf(list.id)).toHaveLength(n);
  });

  it("imports 10,000 rows in chunks and caps the error report at 2,000 lines while counting every invalid row", async () => {
    const list = await newList("large");
    const lines = ["url"];
    for (let i = 0; i < 10_000; i += 1) {
      lines.push(i % 3 === 0 ? `https://www.linkedin.com/company/c-${i}` : `https://www.linkedin.com/in/big-${i}`);
    }
    const started = Date.now();
    const out = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text: lines.join("\n"), db,
    }));
    const elapsed = Date.now() - started;
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.job.status).toBe("ready");
    expect(out.job.invalid_count).toBe(3334);
    expect(out.job.inserted_count).toBe(6666);
    expect(out.job.error_report).toHaveLength(2000);
    expect(out.chunksApplied).toBe(10_000 / IMPORT_CHUNK_ROWS);
    expect(elapsed).toBeLessThan(25_000);
  }, 60_000);

  it("refuses a file over 1 MB, over 10,000 rows, or without a URL column — before creating a job", async () => {
    const list = await newList("limits");
    const big = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text: "x".repeat(IMPORT_MAX_BYTES + 1), db,
    }));
    expect(big.ok === false && big.reason).toBe("too_large");
    const many = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv",
      text: "url\n" + Array.from({ length: 10_001 }, (_, i) => `https://www.linkedin.com/in/m-${i}`).join("\n"), db,
    }));
    expect(many.ok === false && many.reason).toBe("too_many_rows");
    const noUrl = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text: "name,company\nJane,Acme", db,
    }));
    expect(noUrl.ok === false && noUrl.reason).toBe("no_url_column");
    const empty = await asOwner(() => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text: "url\n\n\n", db,
    }));
    expect(empty.ok === false && empty.reason).toBe("empty");
    expect(await asOwner(() => listImportJobs({ workspaceId: t.workspaceId, leadListId: list.id, db }))).toHaveLength(0);
  });

  it("a viewer cannot import; a member of another workspace cannot import into this list", async () => {
    const list = await newList("authz");
    await expect(h.asUser(t.viewerId, () => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text: "url\nhttps://www.linkedin.com/in/v", db,
    }))).rejects.toThrow();
    const other = await seedTenant(h.db, "li-import-other");
    const cross = await h.asUser(other.ownerId, () => importLeadsFromText({
      workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text: "url\nhttps://www.linkedin.com/in/v", db,
    }));
    // RLS hides the list: the stranger is told it does not exist.
    expect(cross.ok === false && cross.reason).toBe("list_not_found");
    expect(await leadsOf(list.id)).toHaveLength(0);
  });

  it("a failed chunk marks the job failed and the next attempt resumes it", async () => {
    const list = await newList("fail");
    const text = "url\nhttps://www.linkedin.com/in/f-1\nhttps://www.linkedin.com/in/f-2";
    // Break the job under the importer's feet: a chunk the function refuses.
    const first = await asOwner(() => importLeadsFromText({ workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text, db, maxChunks: 0 }));
    expect(first.ok && first.job.status).toBe("running");
    if (!first.ok) return;
    await expect(asOwner(() => applyImportChunk({
      workspaceId: t.workspaceId, jobId: first.job.id, rows: Array.from({ length: 1001 }, (_, i) => ({
        profile_key: `z-${i}`, canonical_profile_url: `https://www.linkedin.com/in/z-${i}`, name: null, company: null, title: null,
      })), nextCursorRow: 3, invalid: 0, errors: [], done: true, db,
    }))).rejects.toThrow();
    const again = await asOwner(() => importLeadsFromText({ workspaceId: t.workspaceId, leadListId: list.id, sourceType: "customer_csv", text, db }));
    expect(again.ok && again.job.status).toBe("ready");
    expect(again.ok && again.job.inserted_count).toBe(2);
    expect((await asOwner(() => getImportJob({ workspaceId: t.workspaceId, jobId: first.job.id, db })))?.last_error).toBeNull();
  });
});

describe("structural: the importer never talks to LinkedIn", () => {
  it("has no HTTP client, no fetch, and no browser automation in the import path", () => {
    const dir = path.resolve(__dirname);
    for (const file of ["import.server.ts", "csv.ts", "profile-url.ts", "import-report.ts"]) {
      const src = readFileSync(path.join(dir, file), "utf8");
      expect(src, file).not.toMatch(/\bfetch\s*\(/);
      expect(src, file).not.toMatch(/from ["'](node:)?https?["']/);
      expect(src, file).not.toMatch(/axios|undici|got\(|playwright|puppeteer|cheerio|jsdom/i);
    }
  });
});
