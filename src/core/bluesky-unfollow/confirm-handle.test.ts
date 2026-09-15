import { describe, expect, it } from "vitest";
import {
  canonicalConfirmationHandle,
  confirmationHandleMatches,
  displayConfirmationHandle,
} from "./confirm-handle";

/**
 * Production: the dialog displayed and requested `@webmasterid.bsky.social`
 * and enabled activation only for `@@webmasterid.bsky.social`. The
 * identity's stored handle carries a leading `@`; the dialog stripped
 * one `@` from the typed value and none from the stored one.
 */
const STORED = "@webmasterid.bsky.social"; // as growth_accounts.handle holds it
const SESSION = "webmasterid.bsky.social"; // as the Bluesky session reports it

describe("the value the dialog displays is the value it accepts", () => {
  it("the single-@ form the operator is shown passes against the stored @-handle", () => {
    expect(displayConfirmationHandle(STORED)).toBe("@webmasterid.bsky.social");
    expect(confirmationHandleMatches("@webmasterid.bsky.social", STORED)).toBe(true);
  });

  it("…and against the session's bare handle, which the server compares with", () => {
    expect(confirmationHandleMatches("@webmasterid.bsky.social", SESSION)).toBe(true);
    expect(confirmationHandleMatches("webmasterid.bsky.social", SESSION)).toBe(true);
    expect(confirmationHandleMatches("webmasterid.bsky.social", STORED)).toBe(true);
  });

  it("the double-@ form that production required is NOT a handle", () => {
    expect(canonicalConfirmationHandle("@@webmasterid.bsky.social")).toBeNull();
    expect(confirmationHandleMatches("@@webmasterid.bsky.social", STORED)).toBe(false);
  });

  it("THE OLD EXPRESSION, for the record: it rejected the displayed value", () => {
    // What `_confirm-activation.tsx` computed before this change. Kept
    // here as the negative control the fix is measured against.
    const old = (typed: string, actorHandle: string) =>
      typed.trim().replace(/^@/, "").toLowerCase() === actorHandle.toLowerCase();
    expect(old("@webmasterid.bsky.social", STORED)).toBe(false);
    expect(old("@@webmasterid.bsky.social", STORED)).toBe(true);
  });
});

describe("what is tolerated: case, surrounding whitespace, zero or one @", () => {
  it.each([
    ["WebmasterID.bsky.social", true],
    ["  @webmasterid.bsky.social  ", true],
    ["\t@webmasterid.bsky.social\n", true],
    ["@WEBMASTERID.BSKY.SOCIAL", true],
  ])("%j", (typed, ok) => {
    expect(confirmationHandleMatches(typed, STORED)).toBe(ok);
  });
});

describe("what is refused", () => {
  it.each([
    ["a different account", "@webmasterid2.bsky.social"],
    ["a prefix", "webmasterid.bsky"],
    ["a substring", "bsky.social"],
    ["the handle plus a suffix", "webmasterid.bsky.social.evil"],
    ["interior whitespace", "webmasterid .bsky.social"],
    ["a zero-width joiner inside", "webmaster‍id.bsky.social"],
    ["a Cyrillic lookalike а for a", "webmаsterid.bsky.social"],
    ["a full-width w", "ｗebmasterid.bsky.social"],
    // toLowerCase folds U+212A KELVIN SIGN to ASCII "k"; only the
    // ASCII check before folding keeps this out.
    ["a Kelvin sign for k", "webmasterid.bs\u212Ay.social"],
    ["a trailing dot", "webmasterid.bsky.social."],
    ["a label starting with a hyphen", "-webmasterid.bsky.social"],
    ["one label only", "webmasterid"],
    ["empty", ""],
    ["a lone @", "@"],
    ["two @", "@@webmasterid.bsky.social"],
    ["a DID instead of a handle", "did:plc:incidentoperator"],
  ])("%s → refused", (_label, typed) => {
    expect(confirmationHandleMatches(typed, STORED)).toBe(false);
  });

  it("an expected value that is not itself a handle matches nothing — not even itself", () => {
    expect(confirmationHandleMatches("@@x.y", "@@x.y")).toBe(false);
    expect(confirmationHandleMatches("", "")).toBe(false);
    expect(confirmationHandleMatches(null, null)).toBe(false);
    expect(displayConfirmationHandle("@@x.y")).toBeNull();
    expect(displayConfirmationHandle(null)).toBeNull();
  });

  it("a lookalike that case-folds INTO ascii is refused before folding", () => {
    // "\u212A" (KELVIN SIGN).toLowerCase() === "k". A normaliser that
    // lowercased first would accept it as the real handle.
    expect("\u212A".toLowerCase()).toBe("k");
    expect(canonicalConfirmationHandle("webmasterid.bs\u212Ay.social")).toBeNull();
    expect(confirmationHandleMatches("webmasterid.bs\u212Ay.social", "webmasterid.bsky.social")).toBe(false);
  });

  it("punycode (an internationalised handle in its wire form) is ASCII and accepted as typed", () => {
    expect(confirmationHandleMatches("@xn--80ak6aa92e.bsky.social", "xn--80ak6aa92e.bsky.social")).toBe(true);
  });
});

describe("canonical form", () => {
  it("is idempotent and strips exactly one @", () => {
    const once = canonicalConfirmationHandle("@WebmasterID.bsky.social");
    expect(once).toBe("webmasterid.bsky.social");
    expect(canonicalConfirmationHandle(once)).toBe(once);
    expect(canonicalConfirmationHandle(`@${once}`)).toBe(once);
    expect(canonicalConfirmationHandle(`@@${once}`)).toBeNull();
  });
});
