import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The signing page of an alternate (migration 187): the person who was named to sign instead of another person of their role. While both are open the
// page says who else was asked; once the other person has completed the role, the page is the friendly "already completed" one, in every language, with
// nothing of the document on it (no pages, no files, no code), and it is not worded as a decline or as an error.

vi.mock("./signature-font", () => ({ signatureFont: { variable: "", style: { fontFamily: "Script" } }, signatureFontFamily: "Script" }));

import type { SigningView } from "@/lib/sign/service/signing";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";

import { SignerRoot, type SignerMessages } from "./signer-root";
import { readPageMessages, SIGNER_LOCALES } from "./signer-test-messages";

const found = readPageMessages();
const run = found ? describe : describe.skip;
const all = (found ?? {}) as unknown as SignerMessages;

function view(over: Partial<SigningView> = {}): SigningView {
  return {
    state: "active",
    needsCode: false,
    needsConsent: false,
    consent: { text: "I agree to use electronic records and signatures.", version: "default-v1-en" },
    document: { title: "Lease Agreement", reference: "MA-0007", pageCount: 2, locale: "en", expiresAt: null, message: null, signInOrder: false, codeRequired: false },
    workspace: { name: "Kedai Runcit Ali", logoUrl: null },
    signer: { name: "Ali bin Ahmad", roleKey: "pp_ali", kind: "signer", status: "viewed" },
    content: { fields: [], answers: {}, othersAnswers: {}, others: [], missing: [] },
    ...over,
  };
}

function page(v: SigningView, locale: SignerLocale = "en") {
  return renderToStaticMarkup(<SignerRoot token={"t".repeat(40)} initialView={v} initialSessionOk initialLocale={locale} messages={all} product="Halo" />);
}

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const TITLE: Record<SignerLocale, string> = { en: "Already completed", ms: "Sudah dilengkapkan", zh: "已经完成", ko: "이미 완료되었습니다" };
const NOTE: Record<SignerLocale, string> = { en: "was also asked to do this", ms: "juga diminta melakukan ini", zh: "也被要求办理此事", ko: "도 이 일을 하도록 요청받았습니다" };

run("the page of a person whose role was completed by the other person", () => {
  it.each(SIGNER_LOCALES)("is the friendly page in %s: nothing to do, nothing of the document, no decline wording", (locale) => {
    const html = page(view({ state: "completed_by_other", content: null, signer: { name: "Ali bin Ahmad", roleKey: "pp_ali", kind: "signer", status: "not_needed" } }), locale);
    expect(html).toContain(TITLE[locale]);
    expect(html).toContain("Kedai Runcit Ali");
    // not the document, not a decline, not a failure
    expect(html).not.toContain("Lease Agreement");
    expect(html).not.toMatch(/<canvas|<img[^>]*page/i);
    expect(html).not.toMatch(/Declined|Something went wrong|Problem/);
    expect(errors).toEqual([]);
  });

  it("says in plain English what happened and that no more reminders come", () => {
    const html = page(view({ state: "completed_by_other", content: null, signer: { name: "Ali", roleKey: "pp_ali", kind: "signer", status: "not_needed" } }));
    expect(html).toContain("asked two people to do this, and the other person completed it first");
    expect(html).toContain("you will not get any more reminders");
  });

  it("words a form as a form", () => {
    const html = page(view({ state: "completed_by_other", content: null, document: { ...view().document, mode: "form" }, signer: { name: "Ali", roleKey: "pp_ali", kind: "filler", status: "not_needed" } }));
    expect(html).toContain("to fill in this form");
  });

  it.each(SIGNER_LOCALES)("tells a person who can still do it that another person was asked too (%s)", (locale) => {
    const html = page(view({ alternate: { name: "Siti Finance" } }), locale);
    expect(html).toContain("Siti Finance");
    expect(html).toContain(NOTE[locale]);
    expect(html).toContain("data-alternate-note");
    expect(errors).toEqual([]);
  });

  it("says nothing about an alternate when there is none", () => {
    expect(page(view())).not.toContain("data-alternate-note");
  });
});
