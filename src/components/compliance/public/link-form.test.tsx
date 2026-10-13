import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The personal closure form (/c/link/<token>) in every language, first paint, and the pure helpers its interactions are made of. There is no DOM renderer in
// this repo, so what is checked is the markup the server sends and, for clicking and typing, the helpers the handlers call (the check before sending, the
// multipart post). NOT tested: typing and focus, the file picker, the "too fast" wait, and the real network call.

import { LINK_WORDS } from "@/lib/compliance/chat-link/link-words";
import type { LinkView } from "@/lib/compliance/chat-link/types";
import { ALL_PUBLIC_WORDS } from "@/lib/compliance/public/words";
import { LOCALES } from "@/lib/compliance/types";

import { buildForm, checkBeforeSending, emptyValues, linkIsGone, type FormValues } from "./flow";
import { LinkNotValid, LinkRoot } from "./public-form";

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

const view = (over: Partial<LinkView> = {}): LinkView => ({
  token: "b1.1760349600.0123456789abcdef.sig",
  linkToken: "b1000000000040008000000000000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  workspace: { name: "Vircle", logoUrl: null },
  maskedPhone: "+6012•••••881",
  name: "Siti Aminah",
  email: "siti.contact@example.test",
  banks: ["Maybank", "CIMB Bank"],
  targetDays: 14,
  locale: "en",
  ...over,
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const page = (v: LinkView, locale: (typeof LOCALES)[number], initial?: React.ComponentProps<typeof LinkRoot>["initial"]) => renderToStaticMarkup(<LinkRoot view={v} initialLocale={locale} initial={initial} />);

describe.each(LOCALES)("the personal closure form in %s", (locale) => {
  const w = ALL_PUBLIC_WORDS[locale];
  const lw = LINK_WORDS[locale];

  it("opens on the form itself: the closure warning, the 14 days, the question, and no step to confirm an email", () => {
    const html = page(view(), locale);
    const t = text(html);
    expect(t).toContain(w.closure.title);
    expect(t).toContain(w.closure.warning);
    expect(t).toContain(w.closure.childOnly);
    expect(t).toContain(w.closure.wantClose);
    expect(t).toContain(lw.step.form);
    // there is no emailed code: nothing asks for one
    expect(t).not.toContain(w.verify.title);
    expect(t).not.toContain(w.verify.codeLabel);
    expect(html).not.toContain("autocomplete=\"one-time-code\"");
    expect(html).toContain('lang="' + locale + '"');
    expect(t).toContain("Vircle");
  });

  it("after Yes: the SAME closure fields as the public form (both ticks, the bank account, the declaration)", () => {
    const html = page(view(), locale, { step: "form", values: { wantClose: "yes" } });
    const t = text(html);
    for (const s of [w.form.name.label, w.closure.childrenFinished, w.closure.allowancesStopped, w.closure.reason, w.form.bank.title, w.form.bank.holder, w.form.declaration.text, w.form.submit]) expect(t).toContain(s);
    expect(html).toContain("Maybank");
    expect(html).toContain('name="website"');
  });

  it("asks the parent to TYPE the email (required), suggesting the contact's, and has no confirmed-address line", () => {
    const html = page(view(), locale, { step: "form", values: { wantClose: "yes" } });
    const t = text(html);
    expect(t).toContain(lw.email.label);
    expect(t).toContain(lw.email.help);
    expect(html).toContain('type="email"');
    expect(html).toContain('value="siti.contact@example.test"');
    expect(t).not.toContain(w.form.email.label);
  });

  it("shows the registered phone number MASKED and not editable, never whole", () => {
    const html = page(view(), locale, { step: "form", values: { wantClose: "yes" } });
    const t = text(html);
    expect(t).toContain(lw.phone.label);
    expect(t).toContain(lw.phone.help);
    expect(html).toContain("data-masked-phone");
    expect(t).toContain("+6012•••••881");
    expect(html).not.toContain("123456881");
    // the editable phone field of the public form is not there
    expect(html).not.toContain('id="cmp-phone"');
    expect(t).not.toContain(w.form.phone.help);
  });

  it("asks for the phone number when the case has none", () => {
    const html = page(view({ maskedPhone: null }), locale, { step: "form", values: { wantClose: "yes" } });
    expect(html).toContain('id="cmp-phone"');
    expect(html).not.toContain("data-masked-phone");
  });

  it("prefills the name from the contact, editable", () => {
    const html = page(view(), locale, { step: "form", values: { wantClose: "yes" } });
    expect(html).toContain('id="cmp-name"');
    expect(html).toContain('value="Siti Aminah"');
  });

  it("asks for the authorization letter only when the bank holder name differs", () => {
    const same = page(view(), locale, { step: "form", values: { wantClose: "yes", name: "Siti Aminah binti Yusof", accountHolder: "SITI AMINAH BT YUSOF" } });
    expect(text(same)).not.toContain(w.form.letter.why);
    const differs = page(view(), locale, { step: "form", values: { wantClose: "yes", name: "Siti Aminah", accountHolder: "Ahmad Yusof" } });
    expect(text(differs)).toContain(w.form.letter.why);
  });

  it("ends on the confirmation: the reference, what happens next, the 14-day aim and never the 30-day stop; nothing typed is shown back", () => {
    const html = page(view(), locale, { step: "done", reference: "CMP-2026-000014" });
    const t = text(html);
    expect(t).toContain("CMP-2026-000014");
    expect(t).toContain(w.done.title);
    expect(t).toContain(w.done.nextTitle);
    expect(t).toContain(w.done.next1);
    expect(t).toContain(w.done.safety);
    expect(t).not.toMatch(/\b30\b/);
    expect(t).not.toContain("siti.contact@example.test");
    expect(html).not.toContain("siti.contact@example.test");
    expect(t).toContain(lw.step.done);
  });

  it("says 'No request was made' and offers to go back when the answer is No", () => {
    const t = text(page(view(), locale, { step: "declined" }));
    expect(t).toContain(w.closure.declined.title);
    expect(t).toContain(w.closure.declined.body);
  });

  it("is ONE calm page for a link that does not work: it names no workspace and says nothing about why", () => {
    const html = renderToStaticMarkup(<LinkNotValid initialLocale={locale} />);
    const t = text(html);
    expect(t).toContain(lw.invalid.title);
    expect(t).toContain(lw.invalid.body);
    expect(t).not.toContain("Vircle");
    expect(t).not.toMatch(/expired|used|withdrawn|replaced|revoked|cancel|tamat|过期|만료/i);
    expect(html).not.toContain("<form");
    // the page the form turns into when the server says the link is gone is the same page
    const gone = page(view(), locale, { step: "gone" });
    expect(text(gone)).toContain(lw.invalid.title);
    expect(text(gone)).toContain(lw.invalid.body);
    expect(gone).not.toContain("<form");
  });

  it("never prints the link's token, the page token or the address in the page", () => {
    const html = page(view(), locale, { step: "form", values: { wantClose: "yes" } });
    expect(html).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(html).not.toContain("b1000000000040008000000000000001");
    expect(html).not.toContain("/c/link/");
  });

  it("paints without a single React warning", () => {
    page(view(), locale);
    page(view(), locale, { step: "form", values: { wantClose: "yes" } });
    page(view(), locale, { step: "done", reference: "CMP-2026-000014" });
    expect(errors).toEqual([]);
  });
});

describe("what the personal form's handlers call", () => {
  const values = (over: Partial<FormValues> = {}): FormValues => ({
    ...emptyValues(),
    wantClose: "yes",
    name: "Siti Aminah",
    childrenFinished: true,
    allowancesStopped: true,
    bankChoice: "Maybank",
    accountNumber: "8800123456789012",
    accountHolder: "Siti Aminah",
    declaration: true,
    ...over,
  });
  const rules = { maxAmount: 0, banks: ["Maybank"], phoneFromCase: true };

  it("needs no phone number when it comes from the chat, and requires the email typed", () => {
    expect(checkBeforeSending("closure", values(), {}, rules, { email: "siti@example.test" })).toEqual({});
    expect(checkBeforeSending("closure", values(), {}, rules, { email: "" })).toEqual({ email: "required" });
    expect(checkBeforeSending("closure", values(), {}, rules, { email: "not an email" })).toEqual({ email: "invalid" });
    // the public form's check without the extra is unchanged: the phone is asked for there
    expect(checkBeforeSending("closure", values(), {}, { maxAmount: 0, banks: ["Maybank"] })).toEqual({ phone: "required" });
  });

  it("asks for the phone number when the case has none", () => {
    expect(checkBeforeSending("closure", values(), {}, { ...rules, phoneFromCase: false }, { email: "a@example.test" })).toEqual({ phone: "required" });
  });

  it("keeps the closure rules: both ticks and the declaration, and a letter when the names differ", () => {
    expect(checkBeforeSending("closure", values({ childrenFinished: false, declaration: false }), {}, rules, { email: "a@example.test" })).toEqual({ childrenFinished: "must_acknowledge", declaration: "must_acknowledge" });
    expect(checkBeforeSending("closure", values({ accountHolder: "Ahmad bin Ali" }), {}, rules, { email: "a@example.test" })).toEqual({ letter: "file_required" });
  });

  it("posts the link's own token with the form, in the payload, and the letter as a file", () => {
    const form = buildForm(values(), { token: "page.token", email: "a@example.test", locale: "ms", linkToken: "LINK.TOKEN" }, { letter: { name: "l.pdf", size: 3, file: new File(["abc"], "l.pdf", { type: "application/pdf" }) } }, "");
    const payload = JSON.parse(String(form.get("payload")));
    expect(payload).toMatchObject({ linkToken: "LINK.TOKEN", token: "page.token", email: "a@example.test", locale: "ms", website: "", name: "Siti Aminah" });
    expect(form.get("letter")).toBeInstanceOf(File);
    // the public form's post carries no link token
    expect(JSON.parse(String(buildForm(values(), { token: "t", email: "a@example.test", locale: "en" }, {}, "").get("payload"))).linkToken).toBeUndefined();
  });

  it("takes only 'not_found' for a link that is gone", () => {
    expect(linkIsGone("not_found")).toBe(true);
    for (const c of ["invalid", "rate_limited", "failed", "token_invalid", "unavailable", ""]) expect(linkIsGone(c)).toBe(false);
  });
});
