import { describe, expect, it } from "vitest";
import { classifyReadFailure } from "./read-failure";
import { RepositoryError } from "@/repositories/errors";

describe("an unapplied migration is never presented as temporary", () => {
  it("recognises Postgres 42P01 on the error itself", () => {
    const r = classifyReadFailure({ code: "42P01", message: "relation does not exist" });
    expect(r.kind).toBe("schema_missing");
    expect(r.retryable).toBe(false);
  });

  it("recognises it through a RepositoryError's cause", () => {
    // This is the shape the repository actually throws: fromPostgres
    // keeps the driver error as `cause`.
    const wrapped = new RepositoryError("Could not list candidates.", "unknown", {
      code: "42P01",
      message: 'relation "public.bluesky_candidates" does not exist',
    });
    expect(classifyReadFailure(wrapped).kind).toBe("schema_missing");
  });

  it("recognises the PostgREST schema-cache spelling of the same cause", () => {
    expect(classifyReadFailure({ code: "PGRST205" }).kind).toBe("schema_missing");
    expect(
      classifyReadFailure(
        new Error("Could not find the table 'public.bluesky_candidates' in the schema cache"),
      ).kind,
    ).toBe("schema_missing");
  });

  it("names the cause and says a retry will not help", () => {
    const r = classifyReadFailure({ code: "42P01" });
    expect(r.message).toContain("migration");
    expect(r.message).toContain("not been applied");
    expect(r.message).toContain("Retrying will not help");
  });
});

describe("an authorization failure is never presented as temporary", () => {
  it("recognises insufficient privilege and RLS refusals", () => {
    for (const error of [
      { code: "42501" },
      new Error("permission denied for table bluesky_candidates"),
      new Error("new row violates row-level security policy"),
      new Error("JWT expired"),
    ]) {
      const r = classifyReadFailure(error);
      expect(r.kind).toBe("authorization");
      expect(r.retryable).toBe(false);
    }
  });

  it("says it is a permissions problem rather than a blip", () => {
    const r = classifyReadFailure({ code: "42501" });
    expect(r.message).toContain("permissions problem, not a temporary one");
  });
});

describe("genuinely temporary failures are retryable", () => {
  it("recognises timeouts, dropped connections and saturation", () => {
    for (const error of [
      new Error("fetch failed"),
      new Error("Connection timed out"),
      new Error("ECONNRESET"),
      new Error("sorry, too many connections already"),
      new Error("network error"),
    ]) {
      const r = classifyReadFailure(error);
      expect(r.kind, String(error)).toBe("temporary");
      expect(r.retryable).toBe(true);
    }
  });

  it("reassures that nothing was changed by a failed read", () => {
    expect(classifyReadFailure(new Error("fetch failed")).message).toContain(
      "Nothing was changed",
    );
  });
});

describe("the default is structural, not temporary", () => {
  it("an unrecognised error does NOT offer a retry", () => {
    // Offering a retry for something a retry cannot fix is the more
    // expensive mistake, and it is exactly how an unapplied migration
    // gets hidden behind "try again".
    for (const error of [
      new Error("something inexplicable"),
      {},
      null,
      undefined,
      "a bare string",
    ]) {
      const r = classifyReadFailure(error);
      expect(r.retryable, String(error)).toBe(false);
      expect(r.kind).not.toBe("temporary");
    }
  });

  it("surfaces the original message rather than swallowing it", () => {
    const r = classifyReadFailure(new Error("weird upstream thing"));
    expect(r.message).toContain("weird upstream thing");
  });

  it("no classification returns a message implying the data is simply empty", () => {
    // "No candidates yet" over a failed read is the worst outcome: it
    // reads as success. Every message must say something failed.
    for (const error of [
      { code: "42P01" },
      { code: "42501" },
      new Error("fetch failed"),
      new Error("unknown"),
    ]) {
      const m = classifyReadFailure(error).message.toLowerCase();
      expect(m).toMatch(/could not|refused|not present/);
    }
  });
});
