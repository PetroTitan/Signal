import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * No credential may reach a log, a database column, the UI, or a
 * serialized result.
 *
 * This is checked by READING the shipped source rather than by
 * asserting on one runtime path, because the failure mode is a single
 * call site somewhere doing something reasonable-looking — logging an
 * error object that happens to carry headers, or persisting a whole
 * response. One runtime assertion proves one path; a sweep of the
 * subsystem proves there is no other.
 */

const ROOTS = [
  "src/core/bluesky-unfollow",
  "src/repositories/bluesky-unfollow-repository.ts",
  "src/app/(app)/relationships/unfollow",
  "src/app/api/relationships/unfollow-export",
];

function walk(target: string): string[] {
  const full = path.join(process.cwd(), target);
  const stat = statSync(full);
  if (stat.isFile()) return [full];
  const out: string[] = [];
  for (const entry of readdirSync(full)) {
    out.push(...walk(path.join(target, entry)));
  }
  return out;
}

const FILES = ROOTS.flatMap(walk).filter(
  (f) => f.endsWith(".ts") || f.endsWith(".tsx"),
);

/** Strip comments — a WORD in prose is not a secret in a payload. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * SHIPPED source only.
 *
 * Test files and fixtures are excluded deliberately. A harness holds a
 * literal like "test-access-jwt-never-persisted" because that is what a
 * fake session is; flagging it would train the reader to ignore this
 * guard, which is the only way a guard like this fails.
 */
const SOURCE = FILES.filter(
  (f) => !f.endsWith(".test.ts") && !f.includes(`${path.sep}test-support${path.sep}`),
).map((f) => ({ file: f, text: code(readFileSync(f, "utf8")) }));

describe("no credential is written anywhere durable", () => {
  it("nothing in this subsystem calls console.*", () => {
    // Not a style rule. A `console.error(err)` on a provider failure is
    // exactly how an Authorization header reaches a platform log, and
    // the object that carries one looks entirely ordinary at the call
    // site.
    for (const { file, text } of SOURCE) {
      expect(text, file).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("no token, JWT, header or cookie is assigned into a persisted shape", () => {
    // The columns this subsystem writes are enumerated in the
    // repository. None of them may be fed from a credential-bearing
    // expression.
    const FORBIDDEN = [
      // `accessJwt` may ONLY ever appear as `accessJwt: <session>.accessJwt`
      // — forwarding a resolved session straight into an outgoing
      // request header. A literal, a template, or a value that has been
      // through a variable is how one ends up somewhere it is kept.
      // The whitespace is INSIDE the lookahead on purpose. With
      // `\s*` before it, the engine backtracks `\s*` to zero width and
      // the lookahead then examines a space, which never matches — so
      // the guard would report every line it was written to allow.
      /accessJwt\s*:(?!\s*\w+\.accessJwt\b)/,
      /refreshJwt/,
      /authorization\s*:/i,
      /set-cookie/i,
      /service_role_key/i,
      /SUPABASE_SERVICE_ROLE_KEY/,
    ];
    for (const { file, text } of SOURCE) {
      for (const pattern of FORBIDDEN) {
        const match = pattern.exec(text);
        // `accessJwt: session.accessJwt` inside the provider call is
        // the one legitimate use, and it goes into an outgoing request
        // header, never into a row.
        expect(`${file}: ${match?.[0] ?? ""}`, file).toBe(`${file}: `);
      }
    }
  });

  it("only the provider's own message and error code are persisted", () => {
    // The worker writes `result.message` and `result.errorCode`. Those
    // are fields the classifier extracted from a JSON body — never the
    // response, never the request, never headers.
    const worker = SOURCE.find((s) => s.file.endsWith("worker.server.ts"));
    expect(worker).toBeDefined();
    expect(worker!.text).toContain("errorMessage: result.message");
    // And nothing stringifies a whole response or request anywhere.
    for (const { file, text } of SOURCE) {
      expect(text, file).not.toMatch(/JSON\.stringify\s*\(\s*(res|response|init)\b/);
    }
  });

  it("the CSV export's columns carry no credential", () => {
    const route = SOURCE.find((s) => s.file.includes("unfollow-export"));
    expect(route).toBeDefined();
    const header = /const header = \[([\s\S]*?)\]/.exec(route!.text)?.[1] ?? "";
    // `rkey` is deliberately not in this list: a record key is the
    // PUBLIC address of a record in a public repository, and exporting
    // which one was deleted is the whole point of an audit trail.
    expect(header).not.toMatch(/jwt|token|auth|cookie|secret|password/i);
    expect(header).toContain("deleted_record_rkey");
  });

  it("the export route uses the USER's client, not the service role", () => {
    // The service role bypasses RLS. An export reached by URL must not,
    // or a campaign id in a query string becomes a cross-tenant read.
    const route = SOURCE.find((s) => s.file.includes("unfollow-export"));
    expect(route!.text).toContain("createSupabaseServerClient");
    expect(route!.text).not.toContain("createSupabaseServiceRoleClient");
  });
});

describe("no secret can reach the UI", () => {
  const CLIENT = SOURCE.filter((s) => s.text.includes('"use client"'));

  it("there are client components under test", () => {
    expect(CLIENT.length).toBeGreaterThan(0);
  });

  it("no client component imports anything server-only", () => {
    for (const { file, text } of CLIENT) {
      expect(text, file).not.toMatch(/from\s+["'][^"']*\.server["']/);
      expect(text, file).not.toMatch(/service-role/);
      expect(text, file).not.toMatch(/process\.env/);
    }
  });

  it("the detail page renders only the provider's message as an error", () => {
    const detail = SOURCE.find((s) =>
      s.file.includes("load-detail.server.ts"),
    );
    expect(detail!.text).toContain("lastErrorMessage: campaign.last_error_message");
  });
});

describe("the system still cannot FOLLOW from the unfollow path", () => {
  it("no unfollow module imports createFollowRecord", () => {
    for (const { file, text } of SOURCE) {
      expect(text, file).not.toContain("createFollowRecord");
    }
  });

  it("the worker's only provider mutation is deleteFollowRecord", () => {
    const worker = SOURCE.find((s) => s.file.endsWith("worker.server.ts"))!;
    const mutations = worker.text.match(
      /\b(createFollowRecord|deleteFollowRecord)\b/g,
    );
    expect(new Set(mutations)).toEqual(new Set(["deleteFollowRecord"]));
  });
});
