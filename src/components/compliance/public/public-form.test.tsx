import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The parent form (/c/<slug>) in every language, first paint, and the pure helpers its interactions are made of. There is no DOM renderer in this repo, so
// what is checked is the markup the server sends (the steps, the warnings, the fields, the hidden field, the letter section) and, for clicking and
// typing, the helpers the handlers call (the check before sending, the multipart post, the code-to-sentence mapping). NOT tested: focus moving to the first
// problem, the file picker, the Turnstile widget, the four-second wait after "too fast", and the real network calls.

import { ALL_PUBLIC_WORDS, fillWords } from "@/lib/compliance/public/words";
import type { PublicView } from "@/lib/compliance/public/settings-types";
import { LOCALES } from "@/lib/compliance/types";

import {
  buildForm,
  checkBeforeSending,
  emptyValues,
  firstProblem,
  holderLabel,
  letterNeeded,
  problemText,
  startStep,
  submitErrorKey,
  verifyErrorKey,
  wrongCodeText,
  type FormValues,
} from "./flow";
import { PublicNotAvailable, PublicRoot } from "./public-form";

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

const view = (over: Partial<PublicView> = {}): PublicView => ({
  slug: "close-account-abc23456",
  type: "closure",
  workspace: { name: "Vircle", logoUrl: "https://example.test/logo.png" },
  notice: {},
  maxAmount: 5000,
  banks: ["Maybank", "CIMB Bank"],
  targetDays: 14,
  token: "t.o.k.en",
  captchaKey: null,
  sessionActive: false,
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const page = (v: PublicView, locale: (typeof LOCALES)[number], initial?: React.ComponentProps<typeof PublicRoot>["initial"]) => renderToStaticMarkup(<PublicRoot view={v} initialLocale={locale} initial={initial} />);
/** The markup of the "does this bank account belong to you?" group, or "" when the page has none. */
const ownGroup = (html: string): string => html.match(/<fieldset[^>]*data-bank-own[^>]*>[\s\S]*?<\/fieldset>/)?.[0] ?? "";

describe.each(LOCALES)("the parent form in %s", (locale) => {
  const w = ALL_PUBLIC_WORDS[locale];

  it("starts with the address step: the title, the intro, an email field, the button, a language choice and the workspace's name", () => {
    const html = page(view(), locale);
    const t = text(html);
    expect(t).toContain(w.verify.title);
    expect(t).toContain(w.verify.intro);
    expect(t).toContain(w.verify.emailLabel);
    expect(t).toContain(w.verify.send);
    expect(html).toContain('lang="' + locale + '"');
    expect(html).toContain('type="email"');
    expect(t).toContain("Vircle");
    // all four languages are offered, each written in itself
    for (const name of ["English", "Bahasa Melayu", "中文", "한국어"]) expect(t).toContain(name);
    expect(html).toContain(">" + w.step.verify + "<");
  });

  it("has a hidden field no person reaches and no other field filled in", () => {
    const html = page(view(), locale);
    expect(html).toContain('<input type="text" tabindex="-1" autoComplete="off" name="website" value=""/>');
    expect(html).toMatch(/<div aria-hidden="true" class="absolute -left-\[9999px\][^"]*"><label>Website/);
    expect(html).not.toMatch(/autofocus/i);
  });

  it("shows the closure form: the warning, the child-account note, the 14 days, the question; the fields only after Yes", () => {
    const html = page(view({ sessionActive: true }), locale, { step: "form", email: "siti@example.test" });
    const t = text(html);
    expect(t).toContain(w.closure.title);
    expect(t).toContain(w.closure.warning);
    expect(t).toContain(w.closure.childOnly);
    expect(t).toContain(fillWords(w.closure.aim, { days: 14 }));
    expect(t).toContain(w.closure.wantClose);
    expect(t).toContain(w.closure.yes);
    expect(t).toContain(w.closure.no);
    // nothing else until the answer is Yes
    expect(t).not.toContain(w.closure.childrenFinished);
    expect(html).not.toContain('name="bankChoice"');
  });

  it("after Yes: the details, both acknowledgements, the bank account from a list with Other bank, the declaration, the button; the email masked, never typed back", () => {
    const html = page(view({ sessionActive: true }), locale, { step: "form", email: "siti@example.test", values: { wantClose: "yes" } });
    const t = text(html);
    for (const s of [w.form.name.label, w.form.phone.label, w.form.phone.help, w.closure.childrenFinished, w.closure.allowancesStopped, w.closure.reason, w.form.bank.title, w.form.bank.holder, w.form.declaration.text, w.form.submit]) expect(t).toContain(s);
    expect(t).toContain("s•••@example.test");
    expect(html).not.toContain("siti@example.test");
    expect(html).toContain("Maybank");
    expect(html).toContain("CIMB Bank");
    expect(t).toContain(w.form.bank.other);
    expect(html).not.toContain(w.form.letter.why);
  });

  it("asks \"does this bank account belong to you?\" first in the bank section, as an accessible Yes / No group with nothing chosen", () => {
    const html = page(view(), locale, { step: "form", email: "siti@example.test", values: { wantClose: "yes" } });
    const group = ownGroup(html);
    expect(group).not.toBe("");
    expect(group).toContain('role="radiogroup"');
    expect(group).toContain('aria-required="true"');
    expect(group).toContain("<legend");
    expect(text(group)).toContain(w.form.bank.own.question);
    expect(text(group)).toContain(w.form.bank.own.yes);
    expect(text(group)).toContain(w.form.bank.own.no);
    expect(group.match(/type="radio"/g)).toHaveLength(2);
    expect(group.match(/name="bankOwn"/g)).toHaveLength(2);
    expect(group).toContain('value="yes"');
    expect(group).toContain('value="no"');
    // no default: neither is checked
    expect(group).not.toMatch(/checked/);
    // the first radio is where focus goes when the answer is missing; the error line belongs to the group
    expect(group).toContain('data-field="bankOwn"');
    expect(group).toContain('id="cmp-bankOwn-err"');
    // the question comes after the bank intro and before the bank list and the account number
    expect(html.indexOf(w.form.bank.intro)).toBeLessThan(html.indexOf("data-bank-own"));
    expect(html.indexOf("data-bank-own")).toBeLessThan(html.indexOf('id="cmp-bankChoice"'));
    expect(html.indexOf('id="cmp-bankChoice"')).toBeLessThan(html.indexOf('id="cmp-accountNumber"'));
  });

  it("shows no letter section until the answer is No, and the holder label says 'as on the bank account' then", () => {
    const unanswered = page(view(), locale, { step: "form", email: "siti@example.test", values: { wantClose: "yes" } });
    expect(text(unanswered)).not.toContain(w.form.letter.why);
    expect(unanswered).not.toContain('type="file"');
    expect(text(unanswered)).toContain(w.form.bank.holder);
    const yes = page(view(), locale, { step: "form", email: "siti@example.test", values: { wantClose: "yes", bankOwn: "yes", name: "Siti Aminah", accountHolder: "Ahmad Yusof" } });
    // Yes: no letter, even though the typed names are different
    expect(text(yes)).not.toContain(w.form.letter.why);
    expect(yes).not.toContain('type="file"');
    expect(ownGroup(yes)).toMatch(/value="yes"[^>]*checked|checked[^>]*value="yes"/);
    expect(text(yes)).not.toContain(w.form.bank.holderOther);
    const no = page(view(), locale, { step: "form", email: "siti@example.test", values: { wantClose: "yes", bankOwn: "no", name: "Siti Aminah", accountHolder: "Siti Aminah" } });
    // No: the letter is asked, whatever the names are, with the instruction that it is signed by the account holder
    expect(text(no)).toContain(w.form.letter.title);
    expect(text(no)).toContain(w.form.letter.why);
    expect(text(no)).toContain(w.form.letter.help);
    expect(no).toContain('type="file"');
    expect(text(no)).toContain(w.form.bank.holderOther);
    expect(ownGroup(no)).toMatch(/value="no"[^>]*checked|checked[^>]*value="no"/);
  });

  it("asks the same question on the withdrawal form, with the letter only after a No", () => {
    const base = { step: "form" as const, email: "siti@example.test" };
    const html = page(view({ type: "withdrawal", targetDays: null }), locale, base);
    expect(text(ownGroup(html))).toContain(w.form.bank.own.question);
    expect(text(html)).not.toContain(w.form.letter.why);
    const no = page(view({ type: "withdrawal", targetDays: null }), locale, { ...base, values: { bankOwn: "no" } });
    expect(text(no)).toContain(w.form.letter.why);
    const yes = page(view({ type: "withdrawal", targetDays: null }), locale, { ...base, values: { bankOwn: "yes" } });
    expect(text(yes)).not.toContain(w.form.letter.why);
  });

  it("shows the withdrawal form: not a closure, the amount with its maximum, the reasons, the optional proof, no warning about closing", () => {
    const html = page(view({ type: "withdrawal", targetDays: null }), locale, { step: "form", email: "siti@example.test" });
    const t = text(html);
    expect(t).toContain(w.withdrawal.title);
    expect(t).toContain(w.withdrawal.note);
    expect(t).toContain(w.withdrawal.amount);
    expect(t).toContain(fillWords(w.withdrawal.amountHelp, { max: "5,000" }));
    expect(t).toContain(w.withdrawal.overTopup);
    expect(t).toContain(w.withdrawal.proof);
    expect(t).not.toContain(w.closure.warning);
    expect(t).not.toContain(w.closure.wantClose);
  });

  it("shows the confirmation: the reference, what happens next with the 14 days for a closure, and the safety line; never the 30-day stop", () => {
    const html = page(view(), locale, { step: "done", email: "siti@example.test", reference: "CMP-2026-000123" });
    const t = text(html);
    expect(t).toContain(w.done.title);
    expect(html).toContain("CMP-2026-000123");
    expect(t).toContain(w.done.nextTitle);
    expect(t).toContain(fillWords(w.done.next2Target, { days: 14 }));
    expect(t).toContain(w.done.safety);
    expect(t).toContain("s•••@example.test");
    expect(html).not.toContain("siti@example.test");
    expect(t).not.toMatch(/\b30\b/);
  });

  it("says where to find the reference when a script's post was answered without one, and drops the 14 days for a withdrawal", () => {
    const html = page(view({ type: "withdrawal", targetDays: null }), locale, { step: "done", email: "", reference: null });
    const t = text(html);
    expect(t).toContain(w.done.referenceByEmail);
    expect(t).toContain(w.done.next2);
    expect(t).not.toContain("14");
  });

  it("shows the 'No request was made' page, calm, with a way back", () => {
    const t = text(page(view(), locale, { step: "declined", email: "siti@example.test" }));
    expect(t).toContain(w.closure.declined.title);
    expect(t).toContain(w.closure.declined.body);
    expect(t).toContain(w.closure.declined.back);
  });

  it("puts the workspace's extra notice above the form in the visitor's language, else in English", () => {
    const v = view({ notice: { en: "English notice", ms: "Notis Melayu" } });
    const t = text(page(v, locale));
    expect(t).toContain(locale === "ms" ? "Notis Melayu" : "English notice");
    expect(text(page(view(), locale))).not.toContain("notice");
  });

  it("shows a page that is not available without naming a workspace, in the visitor's language", () => {
    const html = renderToStaticMarkup(<PublicNotAvailable initialLocale={locale} />);
    expect(text(html)).toContain(w.unavailable.title);
    expect(text(html)).toContain(w.unavailable.body);
    expect(text(renderToStaticMarkup(<PublicNotAvailable initialLocale={locale} busy />))).toContain(w.busy.title);
  });

  it("never shows a raw message key or a placeholder left unfilled, and logs no React error", () => {
    const pages = [
      page(view(), locale),
      page(view(), locale, { step: "form", email: "a@b.co", values: { wantClose: "yes", name: "A", accountHolder: "B" } }),
      page(view(), locale, { step: "form", email: "a@b.co", values: { wantClose: "yes", bankOwn: "no", name: "A", accountHolder: "B" } }),
      page(view({ type: "withdrawal" }), locale, { step: "form", email: "a@b.co", values: { reasonKind: "other" } }),
      page(view(), locale, { step: "done", email: "a@b.co", reference: "CMP-2026-000001" }),
    ];
    for (const html of pages) {
      const t = text(html);
      expect(t).not.toMatch(/\{[a-z]+\}/);
      expect(t).not.toMatch(/\b(?:verify|form|closure|withdrawal|done)\.[a-zA-Z]+\b/);
    }
    expect(errors).toEqual([]);
  });
});

describe("the words", () => {
  const shape = (o: unknown, prefix = ""): string[] =>
    o && typeof o === "object" ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => shape(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)];
  const leaves = (o: unknown, prefix = ""): [string, string][] =>
    o && typeof o === "object" ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${prefix}${k}.`)) : [[prefix.slice(0, -1), String(o)]];
  const holders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

  it("has the same sentences in every language, with the same placeholders", () => {
    const en = leaves(ALL_PUBLIC_WORDS.en);
    for (const l of LOCALES) {
      expect(shape(ALL_PUBLIC_WORDS[l]), l).toEqual(shape(ALL_PUBLIC_WORDS.en));
      const other = new Map(leaves(ALL_PUBLIC_WORDS[l]));
      for (const [key, value] of en) {
        expect(other.get(key), `${l} ${key}`).toBeTruthy();
        expect(holders(other.get(key)!), `${l} ${key}`).toBe(holders(value));
      }
    }
  });

  it("words the bank account question, its answers and the letter in every language, without a name comparison or a flag", () => {
    for (const l of LOCALES) {
      const b = ALL_PUBLIC_WORDS[l].form.bank;
      for (const v of [b.own.question, b.own.yes, b.own.no, b.own.required, b.holderOther, ALL_PUBLIC_WORDS[l].form.letter.why]) expect(v.trim().length, l).toBeGreaterThan(0);
      // the question says Vircle once; it names no staff check
      expect(b.own.question, l).toContain("Vircle");
      const all = JSON.stringify(ALL_PUBLIC_WORDS[l]);
      expect(all, l).not.toMatch(/name_differs|check before paying|differs from the account holder/i);
    }
    expect(ALL_PUBLIC_WORDS.en.form.bank.own.question).toBe("Does this bank account belong to you, the Vircle account holder?");
    expect(ALL_PUBLIC_WORDS.en.form.bank.holderOther).toBe("Name of the bank account holder (as on the bank account)");
    // the letter sentence says it is signed by the bank account holder and allows the payment
    expect(ALL_PUBLIC_WORDS.en.form.letter.why).toMatch(/signed by the bank account holder/);
    expect(ALL_PUBLIC_WORDS.en.form.letter.why).toMatch(/pay into this account/);
  });

  it("never tells a parent about the regulatory stop, and never says 'envelope'", () => {
    for (const l of LOCALES) {
      const all = leaves(ALL_PUBLIC_WORDS[l]).map(([, v]) => v).join(" ");
      expect(all, l).not.toMatch(/hard stop|regulat|envelope|\b30\b|30 hari|30 天|30일/i);
    }
  });

  it("keeps the 14-day line free of a fixed number: it is filled from the workspace's own target", () => {
    for (const l of LOCALES) expect(ALL_PUBLIC_WORDS[l].closure.aim).toContain("{days}");
  });
});

describe("the helpers the handlers use", () => {
  const rules = { maxAmount: 5000, banks: ["Maybank", "CIMB Bank"] };
  const closure = (over: Partial<FormValues> = {}): FormValues => ({
    ...emptyValues(),
    wantClose: "yes",
    name: "Siti Aminah",
    phone: "0123344556",
    childrenFinished: true,
    allowancesStopped: true,
    bankOwn: "yes",
    bankChoice: "Maybank",
    accountNumber: "8800123456",
    accountHolder: "Siti Aminah",
    declaration: true,
    ...over,
  });

  it("starts on the form when a session is active and on the address step otherwise", () => {
    expect(startStep(true)).toBe("form");
    expect(startStep(false)).toBe("verify");
  });

  it("finds nothing wrong with a complete closure, and names every missing acknowledgement", () => {
    expect(checkBeforeSending("closure", closure(), {}, rules)).toEqual({});
    const p = checkBeforeSending("closure", closure({ childrenFinished: false, allowancesStopped: false, declaration: false }), {}, rules);
    expect(p).toEqual({ childrenFinished: "must_acknowledge", allowancesStopped: "must_acknowledge", declaration: "must_acknowledge" });
    expect(firstProblem(p)).toBe("childrenFinished");
    expect(firstProblem({})).toBeNull();
  });

  it("wants the letter exactly when the answer is No, and refuses a file over 10 MB", () => {
    expect(letterNeeded({ bankOwn: "yes" })).toBe(false);
    expect(letterNeeded({ bankOwn: "no" })).toBe(true);
    expect(letterNeeded({ bankOwn: "" })).toBe(false);
    const no = closure({ bankOwn: "no", accountHolder: "Ahmad Yusof" });
    expect(checkBeforeSending("closure", no, {}, rules)).toEqual({ letter: "file_required" });
    expect(checkBeforeSending("closure", no, { letter: { name: "l.pdf", size: 1000 } }, rules)).toEqual({});
    expect(checkBeforeSending("closure", no, { letter: { name: "l.pdf", size: 11 * 1024 * 1024 } }, rules)).toEqual({ letter: "file_size" });
    expect(checkBeforeSending("closure", no, { letter: { name: "empty.pdf", size: 0 } }, rules)).toEqual({ letter: "file_required" });
    expect(checkBeforeSending("closure", closure({ wantClose: "no" }), {}, rules)).toEqual({});
  });

  it("does not want a letter, nor look at one, when the answer is Yes: a different name asks for nothing", () => {
    expect(checkBeforeSending("closure", closure({ accountHolder: "Ahmad Yusof" }), {}, rules)).toEqual({});
    // a letter chosen while the answer was No and kept after it became Yes is not checked (and not sent: see the post below)
    expect(checkBeforeSending("closure", closure({ bankOwn: "yes" }), { letter: { name: "big.pdf", size: 11 * 1024 * 1024 } }, rules)).toEqual({});
  });

  it("needs the answer: nothing chosen is a problem on the group, found first among the bank controls", () => {
    const p = checkBeforeSending("closure", closure({ bankOwn: "", bankChoice: "" }), {}, rules);
    expect(p).toEqual({ bankOwn: "required", bankChoice: "required" });
    expect(firstProblem(p)).toBe("bankOwn");
    expect(checkBeforeSending("withdrawal", { ...closure({ bankOwn: "" }), wantClose: "", amount: "100", reasonKind: "over_topup" }, {}, rules)).toEqual({ bankOwn: "required" });
    for (const l of LOCALES) {
      expect(problemText(ALL_PUBLIC_WORDS[l], "required", "bankOwn")).toBe(ALL_PUBLIC_WORDS[l].form.bank.own.required);
      expect(problemText(ALL_PUBLIC_WORDS[l], "required", "accountNumber")).toBe(ALL_PUBLIC_WORDS[l].form.problem.required);
    }
  });

  it("labels the holder name 'as on the bank account' only for a No", () => {
    for (const l of LOCALES) {
      const w = ALL_PUBLIC_WORDS[l];
      expect(holderLabel(w, { bankOwn: "no" })).toBe(w.form.bank.holderOther);
      expect(holderLabel(w, { bankOwn: "yes" })).toBe(w.form.bank.holder);
      expect(holderLabel(w, { bankOwn: "" })).toBe(w.form.bank.holder);
    }
  });

  it("checks a withdrawal's amount and reason", () => {
    const w: FormValues = { ...closure(), wantClose: "", amount: "6000", reasonKind: "other", reasonText: "" };
    expect(checkBeforeSending("withdrawal", w, {}, rules)).toEqual({ amount: "too_large", reasonText: "required" });
  });

  it("builds the multipart post: the details as JSON, the files by name, the hidden field always present", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "letter.pdf", { type: "application/pdf" });
    const form = buildForm(closure(), { token: "tok", email: "siti@example.test", locale: "ms" }, { letter: { name: "letter.pdf", size: 3, file } });
    const payload = JSON.parse(String(form.get("payload")));
    expect(payload).toMatchObject({ token: "tok", email: "siti@example.test", locale: "ms", website: "", wantClose: "yes", name: "Siti Aminah", bankOwn: "yes" });
    // the answer is Yes: a letter picked earlier in the session is dropped and not sent
    expect(form.get("letter")).toBeNull();
    expect(form.get("proof")).toBeNull();
    // the answer is No: the letter goes by its own name
    const notOwn = buildForm(closure({ bankOwn: "no" }), { token: "tok", email: "siti@example.test", locale: "ms" }, { letter: { name: "letter.pdf", size: 3, file } });
    expect(JSON.parse(String(notOwn.get("payload")))).toMatchObject({ bankOwn: "no" });
    expect((notOwn.get("letter") as File).name).toBe("letter.pdf");
    const caught = JSON.parse(String(buildForm(closure(), { token: "t", email: "e", locale: "en" }, {}, "filled").get("payload")));
    expect(caught.website).toBe("filled");
  });

  it("maps the server's codes to the page's sentences", () => {
    expect(submitErrorKey("session_invalid")).toBe("session_invalid");
    expect(submitErrorKey("token_expired")).toBe("token");
    expect(submitErrorKey("token_invalid")).toBe("token");
    expect(submitErrorKey("rate_limited")).toBe("rate_limited");
    expect(submitErrorKey("too_large")).toBe("too_large");
    expect(submitErrorKey("failed")).toBe("failed");
    expect(submitErrorKey("something new")).toBe("failed");
    expect(verifyErrorKey("wrong_code")).toBe("wrong_code");
    expect(verifyErrorKey("not_found")).toBe("unavailable");
    expect(verifyErrorKey("failed")).toBe("network");
    for (const l of LOCALES) {
      const w = ALL_PUBLIC_WORDS[l];
      expect(wrongCodeText(w, 3)).toContain("3");
      expect(problemText(w, "must_acknowledge")).toBe(w.form.problem.must_acknowledge);
      expect(problemText(w, undefined)).toBe("");
      for (const code of ["session_invalid", "rate_limited", "token_too_fast", "too_large", "unavailable", "network", "failed", "x"]) expect(w.form.errors[submitErrorKey(code)]).toBeTruthy();
      for (const code of ["invalid_email", "send_failed", "rate_limited", "wrong_code", "expired", "too_many_attempts", "no_code", "captcha_failed", "unavailable", "network", "other"]) expect(w.verify.errors[verifyErrorKey(code)]).toBeTruthy();
    }
  });
});
