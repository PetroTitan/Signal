import { describe, expect, it } from "vitest";
import {
  validateIdentityReferenceUrls,
  validateIdentitySourceUrl,
} from "./url-validation";

describe("validateIdentitySourceUrl — happy path", () => {
  it("accepts a clean https URL", () => {
    const r = validateIdentitySourceUrl("https://www.webmasterid.com");
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe("https://www.webmasterid.com");
    expect(r.error).toBeNull();
  });

  it("accepts a deeper path verbatim", () => {
    const r = validateIdentitySourceUrl("https://example.com/docs/intro");
    expect(r.ok).toBe(true);
    expect(r.normalized).toBe("https://example.com/docs/intro");
  });

  it("normalizes trailing slash + lowercases host", () => {
    const r = validateIdentitySourceUrl("https://EXAMPLE.com/");
    expect(r.normalized).toBe("https://example.com");
  });

  it("strips query + hash", () => {
    const r = validateIdentitySourceUrl(
      "https://example.com/blog?utm=x#section",
    );
    expect(r.normalized).toBe("https://example.com/blog");
  });

  it("empty + !required → ok, normalized=null", () => {
    const r = validateIdentitySourceUrl("", { required: false });
    expect(r.ok).toBe(true);
    expect(r.normalized).toBeNull();
  });
});

describe("validateIdentitySourceUrl — refusals", () => {
  it("empty + required → url_required", () => {
    const r = validateIdentitySourceUrl("", { required: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("url_required");
  });

  it("garbage → url_invalid_format", () => {
    const r = validateIdentitySourceUrl("not a url");
    expect(r.error).toBe("url_invalid_format");
  });

  it("http://… → url_scheme_must_be_https", () => {
    const r = validateIdentitySourceUrl("http://example.com");
    expect(r.error).toBe("url_scheme_must_be_https");
  });

  it("localhost → url_localhost_not_allowed", () => {
    const r = validateIdentitySourceUrl("https://localhost/x");
    expect(r.error).toBe("url_localhost_not_allowed");
  });

  it("127.0.0.1 → url_localhost_not_allowed", () => {
    const r = validateIdentitySourceUrl("https://127.0.0.1");
    expect(r.error).toBe("url_localhost_not_allowed");
  });

  it("*.vercel.app → url_preview_domain_not_allowed", () => {
    const r = validateIdentitySourceUrl(
      "https://signal-pr-119.vercel.app",
    );
    expect(r.error).toBe("url_preview_domain_not_allowed");
  });

  it("*.netlify.app → url_preview_domain_not_allowed", () => {
    const r = validateIdentitySourceUrl("https://preview.netlify.app");
    expect(r.error).toBe("url_preview_domain_not_allowed");
  });

  it("hostname containing .preview. → preview rejected", () => {
    const r = validateIdentitySourceUrl("https://branch.preview.example.com");
    expect(r.error).toBe("url_preview_domain_not_allowed");
  });

  it("custom port → url_port_not_allowed", () => {
    const r = validateIdentitySourceUrl("https://example.com:3000");
    expect(r.error).toBe("url_port_not_allowed");
  });
});

describe("validateIdentityReferenceUrls", () => {
  it("happy path: list of valid URLs round-trips and normalizes", () => {
    const r = validateIdentityReferenceUrls([
      "https://models.webmasterid.com",
      "https://radar.webmasterid.com/",
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual([
      "https://models.webmasterid.com",
      "https://radar.webmasterid.com",
    ]);
  });

  it("drops empty + whitespace-only entries silently", () => {
    const r = validateIdentityReferenceUrls([
      "https://a.example.com",
      "",
      "   ",
      "https://b.example.com",
    ]);
    expect(r.ok).toBe(true);
    expect(r.normalized).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("collapses duplicates after normalization", () => {
    const r = validateIdentityReferenceUrls([
      "https://example.com/",
      "https://EXAMPLE.com",
      "https://example.com",
    ]);
    expect(r.normalized).toEqual(["https://example.com"]);
  });

  it("any invalid entry fails the list and reports the index + code", () => {
    const r = validateIdentityReferenceUrls([
      "https://ok.example.com",
      "https://localhost",
      "https://ok2.example.com",
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].index).toBe(1);
    expect(r.errors[0].error).toBe("url_localhost_not_allowed");
  });
});
