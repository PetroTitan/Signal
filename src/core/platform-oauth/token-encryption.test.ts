import { afterEach, describe, expect, it } from "vitest";
import {
  getTokenCipher,
  getTokenCipherDiagnostic,
  resetTokenCipherCacheForTests,
} from "./token-encryption";
import { parseKeyFromEnv } from "./token-cipher";

// ---------------------------------------------------------------------
// Regression tests for the cipher diagnostic surface.
//
// The cipher caches on first read (so it doesn't re-parse the env var
// every request). Tests reset the cache between cases using the
// test-only `resetTokenCipherCacheForTests` export.
//
// What we pin:
//   - missing env  → diagnostic.status === "missing", isAvailable() false
//   - malformed    → diagnostic.status === "invalid", isAvailable() false
//   - valid 32b    → diagnostic.status === "configured", isAvailable() true
//   - error messages never contain the env-var VALUE, only the NAME
// ---------------------------------------------------------------------

const VALID_KEY_BASE64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY;
  resetTokenCipherCacheForTests();
});

describe("token cipher — missing TOKEN_ENCRYPTION_KEY", () => {
  it("diagnostic.status is 'missing'", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetTokenCipherCacheForTests();
    expect(getTokenCipherDiagnostic().status).toBe("missing");
  });

  it("cipher refuses to encrypt (no-op)", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetTokenCipherCacheForTests();
    expect(getTokenCipher().isAvailable()).toBe(false);
  });

  it("diagnostic message names the env-var symptom", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetTokenCipherCacheForTests();
    const message = getTokenCipherDiagnostic().message;
    expect(message).toContain("TOKEN_ENCRYPTION_KEY");
  });
});

describe("token cipher — malformed TOKEN_ENCRYPTION_KEY", () => {
  it("rejects a key that decodes to fewer than 32 bytes", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "dGhpcyBpcyB0b28gc2hvcnQ="; // 12 bytes
    resetTokenCipherCacheForTests();
    const diagnostic = getTokenCipherDiagnostic();
    expect(diagnostic.status).toBe("invalid");
    expect(getTokenCipher().isAvailable()).toBe(false);
  });

  it("rejects a key that decodes to more than 32 bytes", () => {
    // 48 bytes base64-encoded
    process.env.TOKEN_ENCRYPTION_KEY =
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v";
    resetTokenCipherCacheForTests();
    expect(getTokenCipherDiagnostic().status).toBe("invalid");
  });

  it("rejects gibberish", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "not-real-base64-!!!";
    resetTokenCipherCacheForTests();
    expect(getTokenCipherDiagnostic().status).toBe("invalid");
  });

  it("rejects whitespace-only", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "   ";
    resetTokenCipherCacheForTests();
    // Whitespace-only is treated as missing by the parser (trims to
    // empty), so the diagnostic reports "missing".
    expect(getTokenCipherDiagnostic().status).toBe("missing");
  });
});

describe("token cipher — valid TOKEN_ENCRYPTION_KEY", () => {
  it("accepts 32-byte base64 (the shape `openssl rand -base64 32` produces)", () => {
    process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY_BASE64;
    resetTokenCipherCacheForTests();
    const diagnostic = getTokenCipherDiagnostic();
    expect(diagnostic.status).toBe("configured");
    expect(getTokenCipher().isAvailable()).toBe(true);
  });

  it("round-trips encrypt/decrypt", () => {
    process.env.TOKEN_ENCRYPTION_KEY = VALID_KEY_BASE64;
    resetTokenCipherCacheForTests();
    const cipher = getTokenCipher();
    const envelope = cipher.encrypt("a-real-bluesky-jwt");
    expect(envelope).not.toBeNull();
    expect(envelope).not.toContain("a-real-bluesky-jwt");
    const plaintext = cipher.decrypt(envelope!);
    expect(plaintext).toBe("a-real-bluesky-jwt");
  });

  it("accepts base64url (no padding) as an alternative format", () => {
    // Same 32 bytes as VALID_KEY_BASE64 but in base64url with no
    // padding.
    process.env.TOKEN_ENCRYPTION_KEY =
      "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    resetTokenCipherCacheForTests();
    expect(getTokenCipherDiagnostic().status).toBe("configured");
  });
});

describe("token cipher — no secret leakage in diagnostics", () => {
  it("the diagnostic message NEVER includes the env-var VALUE", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "PROBE-SECRET-VALUE-DO-NOT-LEAK-1234";
    resetTokenCipherCacheForTests();
    const diagnostic = getTokenCipherDiagnostic();
    expect(diagnostic.message).not.toContain("PROBE-SECRET-VALUE-DO-NOT-LEAK-1234");
  });

  it("the diagnostic message includes the env-var NAME (operator hint, safe to display)", () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetTokenCipherCacheForTests();
    expect(getTokenCipherDiagnostic().message).toContain(
      "TOKEN_ENCRYPTION_KEY",
    );
  });
});

describe("parseKeyFromEnv — format coverage", () => {
  it("accepts standard base64 (with padding)", () => {
    expect(parseKeyFromEnv(VALID_KEY_BASE64)).not.toBeNull();
  });
  it("accepts base64url (no padding)", () => {
    expect(
      parseKeyFromEnv("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"),
    ).not.toBeNull();
  });
  it("rejects null/undefined/empty", () => {
    expect(parseKeyFromEnv(null)).toBeNull();
    expect(parseKeyFromEnv(undefined)).toBeNull();
    expect(parseKeyFromEnv("")).toBeNull();
    expect(parseKeyFromEnv("   ")).toBeNull();
  });
  it("rejects wrong-length keys", () => {
    expect(parseKeyFromEnv("c2hvcnQ=")).toBeNull(); // 5 bytes
    expect(parseKeyFromEnv("dG9vIGxvbmcgZm9yIDMyIGJ5dGVzIGF0IGFsbCBzdXJlbHk=")).toBeNull(); // > 32 bytes
  });
});
