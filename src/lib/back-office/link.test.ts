import { describe, expect, it } from "vitest";

import { getBackOfficeBaseUrl, getBackOfficeEmbed } from "./config";
import { buildBackOfficeUrl, parseBackOfficeBaseUrl, parseBackOfficeEmbed } from "./link";

const UAT = "https://v2-uat.vircle.net/app-user-details-b";

describe("buildBackOfficeUrl", () => {
  it("puts the phone after #q= and encodes a leading plus as %2B", () => {
    expect(buildBackOfficeUrl(UAT, "+60123456789")).toBe(`${UAT}#q=%2B60123456789`);
  });

  it("sends a number with a leading zero exactly as held (no normalising)", () => {
    expect(buildBackOfficeUrl(UAT, "0123456789")).toBe(`${UAT}#q=0123456789`);
  });

  it("trims the phone but changes nothing else in it", () => {
    expect(buildBackOfficeUrl(UAT, "  +60123456789\n")).toBe(`${UAT}#q=%2B60123456789`);
    // inner spaces and punctuation are the person's own: encoded, not removed
    expect(buildBackOfficeUrl(UAT, "+60 12-345 6789")).toBe(`${UAT}#q=%2B60%2012-345%206789`);
  });

  it("never lower-cases (a username-style value keeps its case)", () => {
    expect(buildBackOfficeUrl(UAT, "AbC.XyZ")).toBe(`${UAT}#q=AbC.XyZ`);
  });

  it("encodes unicode", () => {
    expect(buildBackOfficeUrl(UAT, "电话 010")).toBe(`${UAT}#q=${encodeURIComponent("电话 010")}`);
    expect(buildBackOfficeUrl(UAT, "ü")).toBe(`${UAT}#q=%C3%BC`);
  });

  it("uses a fragment, never a query string, so the number is never sent to a server", () => {
    const url = buildBackOfficeUrl(UAT, "+60123456789")!;
    expect(new URL(url).search).toBe("");
    expect(new URL(url).hash).toBe("#q=%2B60123456789");
    expect(url).not.toContain("?");
  });

  it("returns null for an empty, blank or missing phone", () => {
    expect(buildBackOfficeUrl(UAT, "")).toBeNull();
    expect(buildBackOfficeUrl(UAT, "   \t\n")).toBeNull();
    expect(buildBackOfficeUrl(UAT, null)).toBeNull();
    expect(buildBackOfficeUrl(UAT, undefined)).toBeNull();
  });

  it("returns null for a lone surrogate half (encodeURIComponent would throw)", () => {
    expect(buildBackOfficeUrl(UAT, "\ud800")).toBeNull();
  });

  it("strips a query string and a fragment from the base", () => {
    expect(buildBackOfficeUrl(`${UAT}?q=old&x=1#frag`, "0123")).toBe(`${UAT}#q=0123`);
    expect(buildBackOfficeUrl(`${UAT}#frag`, "0123")).toBe(`${UAT}#q=0123`);
  });

  it("refuses an http, other-scheme, credentialed, blank or missing base", () => {
    expect(buildBackOfficeUrl("http://v2-uat.vircle.net/app-user-details-b", "0123")).toBeNull();
    expect(buildBackOfficeUrl("javascript:alert(1)", "0123")).toBeNull();
    expect(buildBackOfficeUrl("ftp://v2-uat.vircle.net/x", "0123")).toBeNull();
    expect(buildBackOfficeUrl("https://user:pass@v2-uat.vircle.net/x", "0123")).toBeNull();
    expect(buildBackOfficeUrl("v2-uat.vircle.net/x", "0123")).toBeNull();
    expect(buildBackOfficeUrl("", "0123")).toBeNull();
    expect(buildBackOfficeUrl(null, "0123")).toBeNull();
    expect(buildBackOfficeUrl(undefined, "0123")).toBeNull();
  });
});

describe("parseBackOfficeBaseUrl", () => {
  it("accepts a valid https URL and returns it without query or fragment", () => {
    expect(parseBackOfficeBaseUrl(UAT)).toBe(UAT);
    expect(parseBackOfficeBaseUrl(`  ${UAT}?a=1#b  `)).toBe(UAT);
  });

  it("rejects everything else", () => {
    for (const bad of [undefined, null, 5, "", "   ", "not a url", "http://example.com/x", "https://", "https://u:p@example.com/"]) {
      expect(parseBackOfficeBaseUrl(bad), String(bad)).toBeNull();
    }
  });
});

describe("parseBackOfficeEmbed", () => {
  it("is on for true or 1 only, in any case", () => {
    for (const on of ["true", "TRUE", " True ", "1", " 1 "]) expect(parseBackOfficeEmbed(on), on).toBe(true);
    for (const off of [undefined, null, "", "0", "false", "yes", "on", "2", "truee", true, 1]) expect(parseBackOfficeEmbed(off), String(off)).toBe(false);
  });
});

describe("configuration read from the environment", () => {
  it("returns the validated address, read at call time", () => {
    expect(getBackOfficeBaseUrl({ BACK_OFFICE_USER_URL: `${UAT}?x=1` })).toBe(UAT);
    expect(getBackOfficeBaseUrl({})).toBeNull();
    expect(getBackOfficeBaseUrl({ BACK_OFFICE_USER_URL: "http://insecure.example/x" })).toBeNull();
    expect(getBackOfficeBaseUrl({ BACK_OFFICE_USER_URL: "garbage" })).toBeNull();
  });

  it("embeds only when switched on AND there is a valid address; off by default", () => {
    expect(getBackOfficeEmbed({ BACK_OFFICE_USER_URL: UAT })).toBe(false);
    expect(getBackOfficeEmbed({ BACK_OFFICE_USER_URL: UAT, BACK_OFFICE_EMBED: "true" })).toBe(true);
    expect(getBackOfficeEmbed({ BACK_OFFICE_USER_URL: UAT, BACK_OFFICE_EMBED: "1" })).toBe(true);
    expect(getBackOfficeEmbed({ BACK_OFFICE_USER_URL: UAT, BACK_OFFICE_EMBED: "no" })).toBe(false);
    expect(getBackOfficeEmbed({ BACK_OFFICE_EMBED: "true" })).toBe(false);
    expect(getBackOfficeEmbed({ BACK_OFFICE_USER_URL: "http://x.example", BACK_OFFICE_EMBED: "true" })).toBe(false);
  });
});
