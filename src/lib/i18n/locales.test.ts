import { describe, expect, it } from "vitest";

import { LOCALE_NAMES, mergeMessages, normalizeLocale, resolveLocale, SUPPORTED_LOCALES } from "./locales";

describe("normalizeLocale", () => {
  it("accepts supported codes in any case and with a region", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("KO")).toBe("ko");
    expect(normalizeLocale("ko-KR")).toBe("ko");
    expect(normalizeLocale("ko_KR")).toBe("ko");
    expect(normalizeLocale(" en-GB ")).toBe("en");
  });
  it("refuses anything else", () => {
    for (const v of ["fr", "es", "pt", "", "  ", null, undefined, "../etc/passwd", "en/../x"]) {
      expect(normalizeLocale(v as string | null | undefined), String(v)).toBeNull();
    }
  });
});

describe("resolveLocale", () => {
  it("prefers the person, then the workspace, then the deployment, then English", () => {
    expect(resolveLocale({ user: "ko", account: "en", deployment: "en" })).toBe("ko");
    expect(resolveLocale({ user: null, account: "ko", deployment: "en" })).toBe("ko");
    expect(resolveLocale({ user: null, account: null, deployment: "ko" })).toBe("ko");
    expect(resolveLocale({})).toBe("en");
  });
  it("skips a choice that is not offered, instead of falling over", () => {
    expect(resolveLocale({ user: "fr", account: "ko" })).toBe("ko");
    expect(resolveLocale({ user: "pt", account: "es", deployment: "xx" })).toBe("en");
  });
});

describe("the offered languages", () => {
  it("each has a name written in itself", () => {
    for (const code of SUPPORTED_LOCALES) expect(LOCALE_NAMES[code]).toBeTruthy();
  });
});

describe("mergeMessages", () => {
  it("lays a translation over English, keeping English for keys not translated yet", () => {
    const en = { A: { x: "one", y: "two" }, B: "bee" };
    expect(mergeMessages(en, { A: { x: "uno" } })).toEqual({ A: { x: "uno", y: "two" }, B: "bee" });
  });
  it("does not change its inputs", () => {
    const en = { A: { x: "one" } };
    mergeMessages(en, { A: { x: "uno" } });
    expect(en).toEqual({ A: { x: "one" } });
  });
  it("lets a translation add a key English does not have", () => {
    expect(mergeMessages({ A: "a" }, { B: "b" })).toEqual({ A: "a", B: "b" });
  });
});
