import { describe, expect, it } from "vitest";

import { describeConfig, parseAllowedHosts, readKycConfig, redact } from "./config";

const GOOD = { KYC_DOC_API_BASE_URL: "https://apis-uat.vircle.com/verify_doc/", KYC_DOC_API_KEY: "  k-123  " };

describe("readKycConfig", () => {
  it("reads a good configuration: trailing slash dropped, key trimmed, UAT recognised", () => {
    const r = readKycConfig(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config).toMatchObject({ baseUrl: "https://apis-uat.vircle.com/verify_doc", apiKey: "k-123", baseHost: "apis-uat.vircle.com", uat: true, allowedImageHosts: [] });
  });

  it("does not call a production host UAT", () => {
    const r = readKycConfig({ ...GOOD, KYC_DOC_API_BASE_URL: "https://apis.vircle.com/verify_doc" });
    expect(r.ok && r.config.uat).toBe(false);
    for (const host of ["apis-staging.vircle.com", "uat.vircle.com", "sandbox.vircle.com", "api.dev.vircle.com", "apis-qa.vircle.com"]) {
      const x = readKycConfig({ ...GOOD, KYC_DOC_API_BASE_URL: `https://${host}/v` });
      expect(x.ok && x.config.uat, host).toBe(true);
    }
  });

  it("names the missing VARIABLES, never their values", () => {
    expect(readKycConfig({})).toEqual({ ok: false, missing: ["KYC_DOC_API_BASE_URL", "KYC_DOC_API_KEY"] });
    expect(readKycConfig({ KYC_DOC_API_BASE_URL: GOOD.KYC_DOC_API_BASE_URL })).toEqual({ ok: false, missing: ["KYC_DOC_API_KEY"] });
    expect(readKycConfig({ KYC_DOC_API_KEY: "secret" })).toEqual({ ok: false, missing: ["KYC_DOC_API_BASE_URL"] });
    expect(readKycConfig({ KYC_DOC_API_BASE_URL: "   ", KYC_DOC_API_KEY: "  " })).toEqual({ ok: false, missing: ["KYC_DOC_API_BASE_URL", "KYC_DOC_API_KEY"] });
  });

  it.each(["http://apis-uat.vircle.com/verify_doc", "ftp://x.example/", "not a url", "https://user:pw@apis.vircle.com/x", "https://apis.vircle.com/x?token=1", "https://apis.vircle.com/x#frag", "//apis.vircle.com"])(
    "treats the base URL %s as unusable",
    (url) => {
      const r = readKycConfig({ KYC_DOC_API_BASE_URL: url, KYC_DOC_API_KEY: "k" });
      expect(r).toEqual({ ok: false, missing: ["KYC_DOC_API_BASE_URL"] });
    },
  );

  it("reads the allow-list of image hosts", () => {
    const r = readKycConfig({ ...GOOD, KYC_DOC_ALLOWED_IMAGE_HOSTS: " *.S3.ap-southeast-1.amazonaws.com , files.example.com., bad host, 10.0.0.1, *.1.2.3.4, ,x" });
    expect(r.ok && r.config.allowedImageHosts).toEqual(["*.s3.ap-southeast-1.amazonaws.com", "files.example.com"]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("localhost,*.com")).toEqual([]);
  });
});

describe("what may be said about the configuration", () => {
  it("never includes the key or the base URL", () => {
    const text = JSON.stringify(describeConfig(readKycConfig(GOOD)));
    expect(text).not.toContain("k-123");
    expect(text).not.toContain("vircle.com");
    expect(describeConfig(readKycConfig(GOOD))).toEqual({ configured: true, uat: true, missing: [] });
    expect(describeConfig(readKycConfig({}))).toEqual({ configured: false, uat: false, missing: ["KYC_DOC_API_BASE_URL", "KYC_DOC_API_KEY"] });
  });

  it("redacts the key and the base URL from any text", () => {
    const r = readKycConfig(GOOD);
    if (!r.ok) throw new Error("expected a configuration");
    const cleaned = redact(`GET ${r.config.baseUrl}/validations failed with key ${r.config.apiKey} (again ${r.config.apiKey})`, r.config);
    expect(cleaned).not.toContain("k-123");
    expect(cleaned).not.toContain("vircle.com");
    expect(redact("nothing here", null)).toBe("nothing here");
  });
});
