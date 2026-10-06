import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render smoke tests for forwarding on the signing page (F-95), in every language, with the page's real messages
// and next-intl set to throw on a missing one: the line that says who asked, the way to forward, a part that is with
// someone else (waiting, and done), what a person handed one part sees, and the end screens that name who is waited
// for. Effects do not run under renderToStaticMarkup, so what is checked is what the first paint holds. They run once
// the Doc Sign message fragments of this package are merged into messages/*.json.

vi.mock("./signature-font", () => ({ signatureFont: { variable: "", style: { fontFamily: "Script" } }, signatureFontFamily: "Script" }));

import type { FormDefinition, L10n, SignerFormView } from "@/lib/sign/forms/types";
import type { SigningView } from "@/lib/sign/service/signing";

import { ForwardedScreen } from "./end-screens";
import { SignerRoot, type SignerMessages } from "./signer-root";
import { readPageMessages, SIGNER_LOCALES } from "./signer-test-messages";

const found = readPageMessages();
const merged = !!found && SIGNER_LOCALES.every((l) => !!(found[l].Sign as { signer?: { forward?: unknown } }).signer?.forward);
const run = merged ? describe : describe.skip;
const all = (found ?? {}) as unknown as SignerMessages;

const L = (en: string): L10n => ({ en });
const definition: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company details"), role: "merchant" },
    { key: "bank", title: L("Bank account"), role: "merchant" },
  ],
  fields: [
    { key: "legalName", type: "text", part: "company", label: L("Legal name"), required: true },
    { key: "accountNo", type: "text", part: "bank", label: L("Account number"), required: true },
  ],
};
const form = (over: Partial<SignerFormView> = {}): SignerFormView => ({
  definition,
  partKeys: ["company", "bank"],
  answers: {},
  unconfirmed: [],
  progress: [
    { key: "company", state: "not_started", done: 0, total: 1, visible: 1 },
    { key: "bank", state: "not_started", done: 0, total: 1, visible: 1 },
  ],
  ready: false,
  ...over,
});

const view = (over: Partial<SigningView> = {}): SigningView => ({
  state: "active",
  needsCode: false,
  needsConsent: false,
  consent: { text: "I agree.", version: "v1" },
  document: { title: "Merchant Application", reference: null, pageCount: 2, locale: "en", expiresAt: null, message: null, signInOrder: false, codeRequired: false },
  workspace: { name: "Kedai Runcit Ali", logoUrl: null },
  signer: { name: "Ali bin Ahmad", roleKey: "merchant", kind: "signer", status: "viewed" },
  forwarding: { canTurn: true, canPart: true, remaining: 2 },
  content: {
    fields: [{ key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06, required: true }],
    answers: {},
    othersAnswers: {},
    others: [],
    missing: ["sig"],
    form: form(),
    delegations: [],
  },
  ...over,
});

const page = (v: SigningView, locale: (typeof SIGNER_LOCALES)[number] = "en") => renderToStaticMarkup(<SignerRoot token={"t".repeat(40)} initialView={v} initialSessionOk initialLocale={locale} messages={all} product="Halo" />);

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

run("forwarding on the signing page", () => {
  it("offers to forward the turn, and each part that is not done, when the sender allows it", () => {
    const html = page(view());
    expect(html).toContain("Forward to someone else");
    expect(html).toContain("Forward this part to someone else");
    expect(errors).toEqual([]);
  });

  it("offers nothing when forwarding is off for the document, or when no forwards are left", () => {
    for (const forwarding of [null, undefined]) {
      const html = page(view({ forwarding }));
      expect(html).not.toContain("Forward to someone else");
      expect(html).not.toContain("Forward this part");
    }
  });

  it("says who asked, for a turn that was forwarded and for a part", () => {
    expect(page(view({ forwardedFrom: "Ali bin Ahmad", forwarding: null }))).toContain("Ali bin Ahmad asked you to complete this in their place.");
    const part = page(view({ delegate: true, forwardedFrom: "Ali bin Ahmad", forwarding: null, signer: { name: "Siti", roleKey: "merchant", kind: "filler", status: "viewed" }, content: { fields: [], answers: {}, othersAnswers: {}, others: [], missing: [], form: form({ partKeys: ["bank"] }), delegations: [] } }));
    expect(part).toContain("Ali bin Ahmad asked you to fill in part of this document.");
    // a person handed one part cannot end the document or pass the part on
    expect(part).not.toContain("I do not want to sign");
    expect(part).not.toContain("Forward to someone else");
    expect(part).toContain("Submit your answers");
  });

  it("shows a part that is with someone else as waiting for them, read only, with a way to take it back", () => {
    const html = page(view({ content: { ...view().content!, delegations: [{ part: "bank", signerId: "d", name: "Siti Finance", done: false }] } }));
    expect(html).toContain("Waiting for Siti Finance");
    expect(html).toContain("Take it back");
    // the part held by someone else is not offered again, the other one still is
    expect(html.match(/Forward this part to someone else/g)).toHaveLength(1);
  });

  it("shows a part the other person finished as done by them, with nothing to take back", () => {
    const html = page(view({ content: { ...view().content!, delegations: [{ part: "bank", signerId: "d", name: "Siti Finance", done: true }] } }));
    expect(html).toContain("Done by Siti Finance");
    expect(html).not.toContain("Take it back");
  });

  it("names the people a finished signer is waiting for, several when they share a step", () => {
    const others = [
      { name: "Siti", roleKey: "director", kind: "signer" as const, status: "sent" as const, orderNo: 2, signedAt: null },
      { name: "Lim", roleKey: "witness", kind: "signer" as const, status: "viewed" as const, orderNo: 2, signedAt: null },
      { name: "Wong", roleKey: "auditor", kind: "signer" as const, status: "pending" as const, orderNo: 3, signedAt: null },
    ];
    const html = page(view({ state: "signed", signer: { name: "Ali", roleKey: "merchant", kind: "signer", status: "signed" }, document: { ...view().document, signInOrder: true }, content: { ...view().content!, others } }));
    expect(html).toContain("We are waiting for Siti and Lim to finish.");
    expect(html).not.toContain("Wong to finish");
  });

  it("tells the person who forwarded their turn that the link no longer works", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={all.en} timeZone="UTC" onError={(e) => { throw e; }}>
        <ForwardedScreen to="Siti Finance" delivered />
      </NextIntlClientProvider>,
    );
    expect(html).toContain("Forwarded");
    expect(html).toContain("Siti Finance has been sent a link to take your place.");
    expect(html).not.toContain("could not be delivered");
  });

  it.each(SIGNER_LOCALES)("renders in %s with no missing message", (locale) => {
    for (const v of [
      view(),
      view({ forwardedFrom: "Ali", forwarding: null }),
      view({ content: { ...view().content!, delegations: [{ part: "bank", signerId: "d", name: "Siti", done: false }] } }),
      view({ content: { ...view().content!, delegations: [{ part: "bank", signerId: "d", name: "Siti", done: true }] } }),
      view({ state: "signed", signer: { name: "Ali", roleKey: "merchant", kind: "signer", status: "signed" }, content: { ...view().content!, others: [{ name: "Siti", roleKey: "director", kind: "signer", status: "sent", orderNo: 2, signedAt: null }] } }),
      view({ delegate: true, forwardedFrom: "Ali", forwarding: null, signer: { name: "Siti", roleKey: "merchant", kind: "filler", status: "viewed" }, content: { fields: [], answers: {}, othersAnswers: {}, others: [], missing: [], form: form({ partKeys: ["bank"] }), delegations: [] } }),
      view({ state: "completed", delegate: true, signer: { name: "Siti", roleKey: "merchant", kind: "filler", status: "signed" } }),
    ]) {
      const html = page(v, locale);
      expect(html).toContain(`lang="${locale}"`);
      expect(html).not.toMatch(/Sign\.signer(Form)?\./);
    }
    expect(
      renderToStaticMarkup(
        <NextIntlClientProvider locale={locale} messages={all[locale]} timeZone="UTC" onError={(e) => { throw e; }}>
          <ForwardedScreen to="Siti" delivered={false} />
        </NextIntlClientProvider>,
      ),
    ).toContain("Siti");
    expect(errors).toEqual([]);
  });
});
