import { describe, expect, it } from "vitest";

import { pickLang } from "./lang";

describe("pickLang", () => {
  it("uses an explicit choice over the phone's setting", () => {
    expect(pickLang("zh", "ms-MY,ms;q=0.9")).toBe("zh");
    expect(pickLang("en", "zh-CN")).toBe("en");
  });
  it("ignores a language we do not have in the explicit choice", () => {
    expect(pickLang("fr", "ms")).toBe("ms");
    expect(pickLang("", null)).toBe("en");
  });
  it("matches the phone's preferred language, regions and scripts included", () => {
    expect(pickLang(null, "ms-MY,ms;q=0.9,en;q=0.8")).toBe("ms");
    expect(pickLang(null, "zh-Hans-CN,zh;q=0.9")).toBe("zh");
    expect(pickLang(null, "en-GB,en;q=0.9")).toBe("en");
  });
  it("respects quality values and header order", () => {
    expect(pickLang(null, "fr,en;q=0.5,zh;q=0.9")).toBe("zh");
    expect(pickLang(null, "ms;q=0.4,zh;q=0.4")).toBe("ms");
    expect(pickLang(null, "zh;q=0,ms;q=0.1")).toBe("ms");
  });
  it("reads Indonesian as Malay, and falls back to English for anything else", () => {
    expect(pickLang(null, "id-ID")).toBe("ms");
    expect(pickLang(null, "ko-KR,fr;q=0.8")).toBe("en");
    expect(pickLang(null, "*")).toBe("en");
  });
});
