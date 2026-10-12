import { describe, expect, it } from "vitest";

import { checkImageUrl, matchesAllowed, registrableDomain } from "./ssrf";

const BASE = "apis-uat.vircle.com";
const ok = (url: string, allowed: string[] = []) => checkImageUrl(url, BASE, allowed);
const reason = (url: string, allowed: string[] = []) => {
  const r = ok(url, allowed);
  return r.ok ? "ok" : r.reason;
};

describe("registrableDomain", () => {
  it.each([
    ["apis-uat.vircle.com", "vircle.com"],
    ["a.b.c.vircle.com", "vircle.com"],
    ["vircle.com", "vircle.com"],
    ["files.vircle.com.my", "vircle.com.my"],
    ["x.example.co.uk", "example.co.uk"],
    ["localhost", "localhost"],
  ])("%s -> %s", (host, domain) => expect(registrableDomain(host)).toBe(domain));
});

describe("matchesAllowed", () => {
  it("matches an exact name or a wildcard subdomain, not the bare suffix and not a look-alike", () => {
    expect(matchesAllowed("bucket.s3.amazonaws.com", ["*.s3.amazonaws.com"])).toBe(true);
    expect(matchesAllowed("s3.amazonaws.com", ["*.s3.amazonaws.com"])).toBe(false);
    expect(matchesAllowed("evil-s3.amazonaws.com", ["*.s3.amazonaws.com"])).toBe(false);
    expect(matchesAllowed("files.example.com", ["files.example.com"])).toBe(true);
    expect(matchesAllowed("x.files.example.com", ["files.example.com"])).toBe(false);
    expect(matchesAllowed("FILES.example.com.", ["files.example.com"])).toBe(true);
  });
});

describe("checkImageUrl", () => {
  it("allows https URLs on the back end's own registrable domain", () => {
    expect(ok("https://files.vircle.com/a.jpg?X-Amz-Signature=abc").ok).toBe(true);
    expect(ok("https://apis-uat.vircle.com/verify_doc/img/1").ok).toBe(true);
    expect(ok("https://a.b.vircle.com:443/x").ok).toBe(true);
  });

  it("allows a host on the allow-list and refuses the same host without it", () => {
    const url = "https://kyc-bucket.s3.ap-southeast-1.amazonaws.com/x.jpg?sig=1";
    expect(reason(url)).toBe("host_not_allowed");
    expect(reason(url, ["*.s3.ap-southeast-1.amazonaws.com"])).toBe("ok");
    expect(reason(url, ["other.example.com"])).toBe("host_not_allowed");
  });

  it("does not treat a shared hosting domain as 'the same domain'", () => {
    const shared = "xyz.execute-api.ap-southeast-1.amazonaws.com";
    expect(checkImageUrl("https://attacker-bucket.s3.amazonaws.com/x", shared, []).ok).toBe(false);
    expect(checkImageUrl("https://attacker-bucket.s3.amazonaws.com/x", shared, ["*.s3.amazonaws.com"]).ok).toBe(true);
  });

  it("refuses look-alike hosts", () => {
    expect(reason("https://vircle.com.evil.example/x")).toBe("host_not_allowed");
    expect(reason("https://evilvircle.com/x")).toBe("host_not_allowed");
    expect(reason("https://vircle.com@evil.example/x")).toBe("credentials");
    expect(reason("https://evil.example/https://files.vircle.com/x")).toBe("host_not_allowed");
  });

  it.each([
    ["http://files.vircle.com/x", "not_https"],
    ["ftp://files.vircle.com/x", "not_https"],
    ["file:///etc/passwd", "not_https"],
    ["javascript:alert(1)", "not_https"],
    ["//files.vircle.com/x", "invalid"],
    ["/relative/path", "invalid"],
    ["", "invalid"],
    ["https://user:pw@files.vircle.com/x", "credentials"],
    ["https://files.vircle.com:8443/x", "port"],
    ["https://files.vircle.com:80/x", "port"],
  ])("refuses %s (%s)", (url, why) => expect(reason(url)).toBe(why));

  it.each([
    "https://127.0.0.1/x",
    "https://10.0.0.5/x",
    "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data/",
    "https://172.16.0.9/x",
    "https://[::1]/x",
    "https://[fe80::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://0x7f.0.0.1/x",
    "https://2130706433/x",
    "https://017700000001/x",
    "https://8.8.8.8/x",
    "https://100.64.0.1/x",
    "https://0.0.0.0/x",
  ])("refuses the address %s whatever the allow-list says", (url) => {
    const r = ok(url, ["*.0.0.1", "127.0.0.1", "8.8.8.8"]);
    expect(r.ok).toBe(false);
  });

  it.each(["https://localhost/x", "https://app.localhost/x", "https://db.internal/x", "https://printer.local/x", "https://intranet/x", "https://host.localdomain/x", "https://metadata.google.internal/x"])(
    "refuses the internal name %s",
    (url) => expect(ok(url, ["*.internal", "localhost", "*.local"]).ok).toBe(false),
  );

  it("refuses a URL that is far too long", () => {
    expect(reason(`https://files.vircle.com/${"a".repeat(5000)}`)).toBe("invalid");
  });

  it("refuses non-ASCII hosts that are not in punycode form after parsing", () => {
    // the parser converts a unicode host to punycode (xn--), which can never be on the base domain or an ASCII allow-list entry
    expect(reason("https://vircle.com.ευ/x")).toBe("host_not_allowed");
  });

  it("is never fooled by an empty base host", () => {
    expect(checkImageUrl("https://files.vircle.com/x", "", []).ok).toBe(false);
  });
});
