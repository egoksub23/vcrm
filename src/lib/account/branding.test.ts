import { describe, expect, it } from "vitest";

import { parseAccountPatch } from "./branding";

describe("parseAccountPatch", () => {
  it("accepts a rename on its own (the original contract)", () => {
    expect(parseAccountPatch({ name: "  Acme  " })).toEqual({ ok: true, value: { name: "Acme" } });
  });

  it("accepts branding, trimming and turning blanks into null", () => {
    expect(parseAccountPatch({ brand_name: " Acme Desk ", brand_logo_url: "https://cdn.example.com/a.png" })).toEqual({
      ok: true,
      value: { brand_name: "Acme Desk", brand_logo_url: "https://cdn.example.com/a.png" },
    });
    expect(parseAccountPatch({ brand_name: "   ", brand_logo_url: "" })).toEqual({
      ok: true,
      value: { brand_name: null, brand_logo_url: null },
    });
    expect(parseAccountPatch({ brand_name: null, brand_logo_url: null })).toEqual({
      ok: true,
      value: { brand_name: null, brand_logo_url: null },
    });
  });

  it.each([
    [null, /Invalid/],
    [[], /Invalid/],
    [{}, /Nothing to update/],
    [{ name: 5 }, /'name'/],
    [{ name: "   " }, /empty/],
    [{ name: "x".repeat(81) }, /80/],
    [{ brand_name: "x".repeat(61) }, /60/],
    [{ brand_name: 7 }, /brand_name/],
    [{ brand_logo_url: "http://cdn.example.com/a.png" }, /https/],
    [{ brand_logo_url: "javascript:alert(1)" }, /https/],
    [{ brand_logo_url: "not a url" }, /valid URL/],
    [{ brand_logo_url: "https://x.co/" + "a".repeat(500) }, /500/],
    [{ brand_logo_url: 3 }, /brand_logo_url/],
  ])("rejects %j", (body, message) => {
    const r = parseAccountPatch(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});
