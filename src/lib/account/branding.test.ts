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

describe("parseAccountPatch: outgoing mail identity", () => {
  it("accepts a sender name and reply-to, trimming and turning blanks into null", () => {
    expect(parseAccountPatch({ email_sender_name: "  Acme Support ", email_reply_to: " help@acme.example " })).toEqual({
      ok: true,
      value: { email_sender_name: "Acme Support", email_reply_to: "help@acme.example" },
    });
    expect(parseAccountPatch({ email_sender_name: "  ", email_reply_to: "" })).toEqual({
      ok: true,
      value: { email_sender_name: null, email_reply_to: null },
    });
    expect(parseAccountPatch({ email_sender_name: null, email_reply_to: null })).toEqual({
      ok: true,
      value: { email_sender_name: null, email_reply_to: null },
    });
  });

  it("accepts non-Latin names and plus-addressing", () => {
    expect(parseAccountPatch({ email_sender_name: "고객 지원", email_reply_to: "a+b@x.example" }).ok).toBe(true);
  });

  it.each([
    [{ email_sender_name: "x".repeat(61) }, /60/],
    [{ email_sender_name: 'Evil" <x@y.z>' }, /cannot contain/],
    [{ email_sender_name: "a,b" }, /cannot contain/],
    [{ email_sender_name: "a;b" }, /cannot contain/],
    [{ email_sender_name: "two\nlines" }, /cannot contain/],
    [{ email_sender_name: 4 }, /email_sender_name/],
    [{ email_reply_to: "nope" }, /single email/],
    [{ email_reply_to: "a@b" }, /single email/],
    [{ email_reply_to: "a@b.co, c@d.co" }, /single email/],
    [{ email_reply_to: "<a@b.co>" }, /single email/],
    [{ email_reply_to: "a@b.co\nBcc: x@y.z" }, /single email/],
    [{ email_reply_to: 4 }, /email_reply_to/],
  ])("rejects %j", (body, message) => {
    const r = parseAccountPatch(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });
});
