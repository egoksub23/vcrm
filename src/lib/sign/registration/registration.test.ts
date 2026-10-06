import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_REGISTRATION_CONSENT, registrationConsentFor } from "./consent";
import { MERGE_ALIASES, mergeValuesFor } from "./merge";
import { MAX_BASE, slugBase } from "./slug-base";
import { SLUG_RE, isValidSlug, makeSlug, normalizeSlug, regenerateSlug } from "./slug";
import { MIN_FILL_MS, TOKEN_TTL_MS, checkFormToken, hashEmail, hashIp, isTooFast, issueFormToken, readFormToken } from "./token";
import { verifyTurnstile, turnstileEnabled, turnstileSiteKey } from "./turnstile";
import { DEFAULT_ASKED, type AskedFields } from "./types";
import { askedFrom, parseFormInput, parseSubmission, peekTrap } from "./validate";

const FORM = "11111111-1111-4111-8111-111111111111";
const OTHER_FORM = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
});
afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("slugs", () => {
  it("makes a readable start and a random end that fits the database rule", () => {
    for (const name of ["Merchant sign-up", "Kedai Runcit Ali (2026)", "中文名称", "a", "   ", "x".repeat(200), "Café Déjà-vu"]) {
      const slug = makeSlug(name);
      expect(slug, name).toMatch(SLUG_RE);
      expect(slug.length).toBeGreaterThanOrEqual(6);
      expect(slug.length).toBeLessThanOrEqual(40);
    }
    expect(makeSlug("Merchant sign-up")).toMatch(/^merchant-sign-up-[a-hj-km-np-z2-9]{8}$/);
    expect(makeSlug("中文名称")).toMatch(/^register-/);
  });

  it("never makes the same address twice and never includes anything but the name and a random end", () => {
    const seen = new Set(Array.from({ length: 500 }, () => makeSlug("Merchant sign-up")));
    expect(seen.size).toBe(500);
  });

  it("folds accents and keeps the start within the limit", () => {
    expect(slugBase("Café Déjà-vu")).toBe("cafe-deja-vu");
    expect(slugBase("x".repeat(200)).length).toBe(MAX_BASE);
    expect(slugBase("---")).toBe("register");
    expect(slugBase("ab--cd--").endsWith("-")).toBe(false);
  });

  it("regenerates with the same start and a new end", () => {
    const first = makeSlug("Merchant sign-up");
    const second = regenerateSlug(first);
    expect(second).not.toBe(first);
    expect(second.startsWith("merchant-sign-up-")).toBe(true);
    expect(second).toMatch(SLUG_RE);
    // a slug an admin never had a suffix on keeps its own start
    expect(regenerateSlug("merchant")).toMatch(/^merchant-[a-hj-km-np-z2-9]{8}$/);
  });

  it("accepts only addresses the database accepts, whatever the case", () => {
    expect(normalizeSlug("  Merchant-7K2M9X4Q ")).toBe("merchant-7k2m9x4q");
    for (const bad of ["", "ab", "abcde", "-abcdef", "abcdef-", "has space", "under_score", "a".repeat(41), "../etc/passwd", undefined, 5, null, "slug\n"]) {
      expect(normalizeSlug(bad), String(bad)).toBeNull();
    }
    expect(isValidSlug("abcdef")).toBe(true);
    expect(isValidSlug("ABCDEF")).toBe(false);
  });
});

describe("the form token", () => {
  const issuedAt = new Date("2026-10-06T08:00:00Z");
  const at = (ms: number) => new Date(issuedAt.getTime() + ms);

  it("is genuine for its own form after the minimum time", () => {
    const token = issueFormToken(FORM, issuedAt)!;
    expect(token).toMatch(new RegExp(`^${FORM}\\.\\d+\\.[0-9a-f]{16}\\.`));
    expect(checkFormToken(token, FORM, at(MIN_FILL_MS))).toEqual({ ok: true });
    expect(checkFormToken(token, FORM, at(60 * 60 * 1000))).toEqual({ ok: true });
  });

  it("is too fast before three seconds, but still readable so the details can be judged first", () => {
    const token = issueFormToken(FORM, issuedAt)!;
    expect(checkFormToken(token, FORM, at(MIN_FILL_MS - 1))).toEqual({ ok: false, reason: "token_too_fast" });
    const read = readFormToken(token, FORM, at(500));
    expect(read).toMatchObject({ ok: true });
    expect(isTooFast((read as { ageMs: number }).ageMs)).toBe(true);
    expect(isTooFast(MIN_FILL_MS)).toBe(false);
  });

  it("expires after two hours", () => {
    const token = issueFormToken(FORM, issuedAt)!;
    expect(checkFormToken(token, FORM, at(TOKEN_TTL_MS))).toEqual({ ok: true });
    expect(checkFormToken(token, FORM, at(TOKEN_TTL_MS + 1000))).toEqual({ ok: false, reason: "token_expired" });
  });

  it("refuses a token that was changed, made for another form, or never made here", () => {
    const token = issueFormToken(FORM, issuedAt)!;
    const parts = token.split(".");
    const tampered = [
      `${parts[0]}.${Number(parts[1]) - 3600}.${parts[2]}.${parts[3]}`, // an older time, to dodge the minimum
      `${parts[0]}.${parts[1]}.${"0".repeat(16)}.${parts[3]}`, // another nonce
      `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3].slice(0, -2)}AA`, // a changed signature
      `${OTHER_FORM}.${parts[1]}.${parts[2]}.${parts[3]}`, // another form's id on the same signature
      `${parts[0]}.${parts[1]}.${parts[2]}`, // missing the signature
      `${token}.extra`,
      "",
      "not a token",
    ];
    for (const t of tampered) expect(checkFormToken(t, FORM, at(10_000)), t).toEqual({ ok: false, reason: "token_invalid" });
    // a genuine token for another form does not open this one
    expect(checkFormToken(issueFormToken(OTHER_FORM, issuedAt), FORM, at(10_000))).toEqual({ ok: false, reason: "token_invalid" });
    for (const v of [undefined, null, 5, {}, ["x"]]) expect(checkFormToken(v, FORM, at(10_000))).toEqual({ ok: false, reason: "token_invalid" });
  });

  it("refuses a token from the future", () => {
    const token = issueFormToken(FORM, at(10 * 60 * 1000))!;
    expect(checkFormToken(token, FORM, issuedAt)).toEqual({ ok: false, reason: "token_invalid" });
  });

  it("cannot be made or checked without a key, and a different key does not open it", () => {
    const token = issueFormToken(FORM, issuedAt)!;
    process.env.ENCRYPTION_KEY = "cd".repeat(32);
    expect(checkFormToken(token, FORM, at(10_000))).toEqual({ ok: false, reason: "token_invalid" });
    delete process.env.ENCRYPTION_KEY;
    expect(issueFormToken(FORM, issuedAt)).toBeNull();
    expect(checkFormToken(token, FORM, at(10_000))).toEqual({ ok: false, reason: "token_invalid" });
  });
});

describe("keyed hashes", () => {
  it("never keep the address or the email, and agree with themselves", () => {
    const ip = hashIp("203.0.113.9")!;
    const mail = hashEmail("Ali@Kedai.example")!;
    expect(ip).toMatch(/^[0-9a-f]{64}$/);
    expect(mail).toMatch(/^[0-9a-f]{64}$/);
    expect(ip).not.toContain("203");
    expect(hashIp("203.0.113.9")).toBe(ip);
    expect(hashEmail(" ali@kedai.example ")).toBe(mail); // case and spaces do not make a different person
    expect(hashEmail("other@kedai.example")).not.toBe(mail);
    // an address and an email that look alike do not collide across kinds
    expect(hashIp("a@b.c")).not.toBe(hashEmail("a@b.c"));
  });

  it("depend on the server's secret", () => {
    const a = hashEmail("ali@kedai.example");
    process.env.ENCRYPTION_KEY = "cd".repeat(32);
    expect(hashEmail("ali@kedai.example")).not.toBe(a);
    delete process.env.ENCRYPTION_KEY;
    expect(hashEmail("ali@kedai.example")).toBeNull();
    expect(hashIp("203.0.113.9")).toBeNull();
  });

  it("have nothing to say about an unknown address", () => {
    expect(hashIp("unknown")).toBeNull();
    expect(hashIp(null)).toBeNull();
    expect(hashIp("")).toBeNull();
  });
});

describe("a submission", () => {
  const good = { fullName: "Ali bin Ahmad", company: "Kedai Runcit Ali", email: "Ali@Kedai.example", phone: "+60 12-345 6789", consent: true, locale: "ms", token: "t", website_url: "" };

  it("is cleaned: trimmed, lower-case email, digits-only phone, a language only when it is one of ours", () => {
    const r = parseSubmission({ ...good, fullName: "  Ali   bin\tAhmad ", locale: "xx" }, DEFAULT_ASKED);
    expect(r).toEqual({ ok: true, value: { fullName: "Ali bin Ahmad", email: "ali@kedai.example", phone: "60123456789", company: "Kedai Runcit Ali", locale: null, token: "t", captcha: null, honeypot: "" } });
    expect(parseSubmission(good, DEFAULT_ASKED)).toMatchObject({ ok: true, value: { locale: "ms" } });
  });

  it("says which detail is wrong and why", () => {
    expect(parseSubmission({}, DEFAULT_ASKED)).toEqual({ ok: false, problems: { full_name: "required", company: "required", email: "required", consent: "required" } });
    expect(parseSubmission({ ...good, fullName: "x".repeat(121) }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { full_name: "too_long" } });
    expect(parseSubmission({ ...good, company: "y".repeat(161) }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { company: "too_long" } });
    expect(parseSubmission({ ...good, email: "not an email" }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { email: "invalid" } });
    expect(parseSubmission({ ...good, email: `${"a".repeat(250)}@b.example` }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { email: "too_long" } });
    expect(parseSubmission({ ...good, phone: "012-3456789" }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { phone: "invalid" } });
    expect(parseSubmission({ ...good, phone: "1".repeat(40) }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { phone: "too_long" } });
    expect(parseSubmission({ ...good, consent: "true" }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { consent: "required" } });
    expect(parseSubmission({ ...good, consent: 1 }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { consent: "required" } });
  });

  it("refuses markup and treats anything that is not text as empty", () => {
    expect(parseSubmission({ ...good, fullName: "<script>alert(1)</script>" }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { full_name: "invalid" } });
    expect(parseSubmission({ ...good, company: "A & B <b>Sdn Bhd</b>" }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { company: "invalid" } });
    expect(parseSubmission({ ...good, email: "a<b>@c.example" }, DEFAULT_ASKED)).toEqual({ ok: false, problems: { email: "invalid" } });
    expect(parseSubmission({ ...good, fullName: ["Ali"], company: { a: 1 } }, DEFAULT_ASKED)).toMatchObject({ ok: false, problems: { full_name: "required", company: "required" } });
    for (const body of [null, undefined, 5, "x", [], [1]]) expect(parseSubmission(body, DEFAULT_ASKED)).toMatchObject({ ok: false, problems: { email: "required", consent: "required" } });
  });

  it("removes control characters and keeps each detail to one line", () => {
    const r = parseSubmission({ ...good, fullName: "Ali\u0000\nbin\u0007 Ahmad" }, DEFAULT_ASKED);
    expect(r).toMatchObject({ ok: true, value: { fullName: "Ali bin Ahmad" } });
  });

  it("asks only what the form asks: a hidden detail is ignored and an optional one may be empty", () => {
    const asked: AskedFields = { full_name: "off", email: "required", phone: "off", company: "optional" };
    const r = parseSubmission({ email: "a@b.example", consent: true, fullName: "ignored", phone: "garbage", company: "" }, asked);
    expect(r).toMatchObject({ ok: true, value: { fullName: null, phone: null, company: null, email: "a@b.example" } });
    expect(parseSubmission({ email: "a@b.example", consent: true, phone: "" }, { ...DEFAULT_ASKED, full_name: "off", company: "off" })).toMatchObject({ ok: true, value: { phone: null } });
    expect(parseSubmission({ email: "a@b.example", consent: true }, { ...DEFAULT_ASKED, full_name: "off", company: "off", phone: "required" })).toEqual({ ok: false, problems: { phone: "required" } });
  });

  it("carries the hidden field: anything at all in it is a script", () => {
    expect(peekTrap({ website_url: "" })).toMatchObject({ honeypot: "" });
    expect(peekTrap({})).toMatchObject({ honeypot: "" });
    expect(peekTrap({ website_url: "http://spam.example" }).honeypot).not.toBe("");
    expect(peekTrap({ website_url: " x " }).honeypot).toBe("x");
    expect(peekTrap({ website_url: true }).honeypot).not.toBe("");
    expect(peekTrap({ website_url: 0 }).honeypot).not.toBe("");
    expect(peekTrap({ website_url: ["a"] }).honeypot).not.toBe("");
    expect(peekTrap({ token: "x".repeat(1000) }).token.length).toBe(300);
    expect(parseSubmission({ ...good, website_url: "bot" }, DEFAULT_ASKED)).toMatchObject({ ok: true, value: { honeypot: "bot" } });
  });

  it("caps the Turnstile token", () => {
    const r = parseSubmission({ ...good, captcha: "c".repeat(5000) }, DEFAULT_ASKED);
    expect((r as { value: { captcha: string } }).value.captcha.length).toBe(2100);
  });
});

describe("an admin's form", () => {
  it("takes only what it recognises and cleans it", () => {
    const r = parseFormInput({
      name: "  Merchant   sign-up ",
      active: true,
      sendDocument: true,
      templateId: "33333333-3333-4333-8333-333333333333",
      applicantRoleKey: "merchant",
      signersOther: [{ role_key: "director", name: " Siti ", email: " SITI@Vircle.example ", channel: "email" }],
      contactTagId: "",
      fields: { phone: "off", email: "optional", company: "optional" },
      consentText: { en: " We keep it. ", ms: "", fr: undefined },
      successMessage: { en: "Thanks" },
      defaultLocale: "ms",
      dailyCap: 50,
    });
    // consentText.fr is not a string: refused, not silently dropped
    expect(r.ok).toBe(false);
    const ok = parseFormInput({
      name: "  Merchant   sign-up ",
      active: true,
      sendDocument: true,
      templateId: "33333333-3333-4333-8333-333333333333",
      applicantRoleKey: "merchant",
      signersOther: [{ role_key: "director", name: " Siti ", email: " SITI@Vircle.example ", channel: "email" }],
      contactTagId: "",
      fields: { phone: "off", email: "optional", company: "optional" },
      consentText: { en: " We keep it. ", ms: "" },
      successMessage: { en: "Thanks" },
      defaultLocale: "ms",
      dailyCap: 50,
    });
    expect(ok).toEqual({
      ok: true,
      value: {
        name: "Merchant sign-up",
        active: true,
        sendDocument: true,
        templateId: "33333333-3333-4333-8333-333333333333",
        applicantRoleKey: "merchant",
        signersOther: [{ role_key: "director", name: "Siti", email: "siti@vircle.example", channel: "email", phone: null }],
        contactTagId: null,
        // the email is always required, whatever was sent
        fields: { full_name: "required", email: "required", phone: "off", company: "optional" },
        consentText: { en: "We keep it." },
        successMessage: { en: "Thanks" },
        defaultLocale: "ms",
        dailyCap: 50,
      },
    });
  });

  it("is a change when it sends only some of the fields", () => {
    expect(parseFormInput({ active: false })).toEqual({ ok: true, value: { active: false } });
    expect(parseFormInput({})).toEqual({ ok: true, value: {} });
  });

  it("says what is wrong", () => {
    const codes = (body: unknown) => (parseFormInput(body) as { issues: { code: string }[] }).issues.map((i) => i.code);
    expect(parseFormInput(null)).toEqual({ ok: false, issues: [{ code: "bad_form" }] });
    expect(parseFormInput([])).toMatchObject({ ok: false });
    expect(codes({ name: " " })).toEqual(["bad_name"]);
    expect(codes({ name: "x".repeat(121) })).toEqual(["bad_name"]);
    expect(codes({ name: "<b>x</b>" })).toEqual(["bad_name"]);
    expect(codes({ active: "yes", sendDocument: 1 })).toEqual(["bad_flag", "bad_flag"]);
    expect(codes({ templateId: "nope", contactTagId: 5 })).toEqual(["bad_id", "bad_id"]);
    expect(codes({ applicantRoleKey: "9bad" })).toEqual(["bad_role"]);
    expect(codes({ fields: { phone: "maybe" } })).toEqual(["bad_fields"]);
    expect(codes({ defaultLocale: "fr" })).toEqual(["bad_locale"]);
    for (const n of [0, 5001, 1.5, "10", NaN]) expect(codes({ dailyCap: n }), String(n)).toEqual(["bad_cap"]);
    expect(codes({ consentText: { en: "x".repeat(2001) } })).toEqual(["wording_too_long"]);
    expect(codes({ successMessage: { en: "x".repeat(1001) } })).toEqual(["wording_too_long"]);
    expect(codes({ consentText: [] })).toEqual(["bad_wording"]);
    expect(codes({ signersOther: "x" })).toEqual(["bad_signers"]);
    expect(codes({ signersOther: Array.from({ length: 11 }, () => ({})) })).toEqual(["bad_signers"]);
  });

  it("checks the people for the other roles", () => {
    const codes = (s: unknown[]) => (parseFormInput({ signersOther: s }) as { issues: { code: string }[] }).issues.map((i) => i.code);
    expect(codes([{ role_key: "director", name: "", email: "a@b.example" }])).toEqual(["signer_name"]);
    expect(codes([{ role_key: "director", name: "Siti", email: "nope" }])).toEqual(["signer_email"]);
    expect(codes([{ role_key: "bad key", name: "Siti", email: "a@b.example" }])).toEqual(["signer_role"]);
    expect(codes([{ role_key: "director", name: "Siti", email: "a@b.example" }, { role_key: "director", name: "Ali", email: "b@b.example" }])).toEqual(["signer_role"]);
    expect(codes([{ role_key: "director", name: "Siti", email: "a@b.example", channel: "whatsapp" }])).toEqual(["signer_phone"]);
    expect(parseFormInput({ signersOther: [{ role_key: "director", name: "Siti", email: "a@b.example", channel: "whatsapp", phone: "+60 12-345 6789" }] })).toMatchObject({ ok: true, value: { signersOther: [{ phone: "+60123456789" }] } });
    expect(codes(["x"])).toEqual(["bad_signers"]);
  });

  it("never lets the email be optional or hidden", () => {
    expect(askedFrom({ email: "off" })?.email).toBe("required");
    expect(askedFrom({})).toEqual(DEFAULT_ASKED);
    expect(askedFrom("x")).toBeNull();
    expect(askedFrom({ company: "sometimes" })).toBeNull();
  });
});

describe("what fills the document", () => {
  const who = { fullName: "Ali bin Ahmad", email: "ali@kedai.example", phone: "60123456789", company: "Kedai Runcit Ali" };

  it("fills only keys the template uses, from only what the applicant typed", () => {
    const fields = [{ merge: "business_name" }, { merge: "Contact_Name" }, { merge: "email" }, { merge: "mobile" }, { merge: "fee_rate" }, {}, { merge: "business_name" }];
    expect(mergeValuesFor(fields, who)).toEqual({ business_name: "Kedai Runcit Ali", Contact_Name: "Ali bin Ahmad", email: "ali@kedai.example", mobile: "+60123456789" });
    // a key it does not know stays for the sender to fill
    expect(mergeValuesFor([{ merge: "fee_rate" }], who)).toEqual({});
    expect(mergeValuesFor([], who)).toEqual({});
  });

  it("leaves out what was not given", () => {
    expect(mergeValuesFor([{ merge: "company" }, { merge: "phone" }, { merge: "name" }], { fullName: null, email: "a@b.example", phone: null, company: null })).toEqual({});
  });

  it("has no alias in two details at once", () => {
    const all = Object.values(MERGE_ALIASES).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("the agreement wording", () => {
  it("uses the product's own words in every language, with the workspace's name in them", () => {
    for (const l of ["en", "ms", "zh", "ko"] as const) {
      const c = registrationConsentFor(null, l, "Vircle");
      expect(c.custom).toBe(false);
      expect(c.version).toBe(`default-v1-${l}`);
      expect(c.text).toContain("Vircle");
      expect(c.text).not.toContain("{workspace}");
      expect(DEFAULT_REGISTRATION_CONSENT[l]).toContain("{workspace}");
    }
  });

  it("uses the form's own wording for a language it set, with a version that follows the words and not the name", () => {
    const a = registrationConsentFor({ en: "We keep it for {workspace}." }, "en", "Vircle");
    const b = registrationConsentFor({ en: "We keep it for {workspace}." }, "en", "Other Co");
    expect(a.custom).toBe(true);
    expect(a.text).toBe("We keep it for Vircle.");
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^custom-en-[0-9a-f]{10}$/);
    expect(registrationConsentFor({ en: "Changed words" }, "en", "Vircle").version).not.toBe(a.version);
    // a language it did not set falls back to the product's
    expect(registrationConsentFor({ en: "x" }, "ms", "Vircle")).toMatchObject({ custom: false, version: "default-v1-ms" });
    expect(registrationConsentFor({ en: "   " }, "en", "Vircle").custom).toBe(false);
  });
});

describe("Turnstile", () => {
  const env = { NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAA", TURNSTILE_SECRET_KEY: "0x4BBB" };

  it("is on only when both keys are set", () => {
    expect(turnstileEnabled(env)).toBe(true);
    expect(turnstileSiteKey(env)).toBe("0x4AAA");
    expect(turnstileEnabled({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0x4AAA" })).toBe(false);
    expect(turnstileEnabled({ TURNSTILE_SECRET_KEY: "0x4BBB" })).toBe(false);
    expect(turnstileEnabled({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: "  ", TURNSTILE_SECRET_KEY: "x" })).toBe(false);
    expect(turnstileSiteKey({})).toBeNull();
  });

  it("asks Cloudflare at its one address with the secret, the token and the caller's address", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    expect(await verifyTurnstile("tok", "203.0.113.9", { env, fetcher })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(calls[0].init.method).toBe("POST");
    const body = calls[0].init.body as URLSearchParams;
    expect(body.get("secret")).toBe("0x4BBB");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.9");
    await verifyTurnstile("tok", "unknown", { env, fetcher });
    expect((calls[1].init.body as URLSearchParams).has("remoteip")).toBe(false);
  });

  it("refuses unless Cloudflare says success, and when it cannot be asked", async () => {
    const reply = (body: unknown, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    expect(await verifyTurnstile("tok", null, { env, fetcher: reply({ success: false, "error-codes": ["invalid-input-response"] }) })).toBe(false);
    expect(await verifyTurnstile("tok", null, { env, fetcher: reply({ success: "true" }) })).toBe(false);
    expect(await verifyTurnstile("tok", null, { env, fetcher: reply({}, 200) })).toBe(false);
    expect(await verifyTurnstile("tok", null, { env, fetcher: reply("<html>", 200) })).toBe(false);
    expect(await verifyTurnstile("tok", null, { env, fetcher: reply({ success: true }, 500) })).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verifyTurnstile("tok", null, { env, fetcher: async () => { throw new Error("network down"); } })).toBe(false);
    // no token, or no secret: nothing is asked
    const never = vi.fn();
    expect(await verifyTurnstile(null, null, { env, fetcher: never })).toBe(false);
    expect(await verifyTurnstile("", null, { env, fetcher: never })).toBe(false);
    expect(await verifyTurnstile("tok", null, { env: {}, fetcher: never })).toBe(false);
    expect(never).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
