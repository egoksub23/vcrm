import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render smoke tests for the signing page: every screen renders from a view, in every language, with the
// page's real messages, and none shows a raw key. Effects do not run under renderToStaticMarkup, so what is
// checked is what the first paint (the server's render) holds. The script font comes from next/font, which
// only works inside Next's compiler, so it is replaced here.

vi.mock("./signature-font", () => ({ signatureFont: { variable: "", style: { fontFamily: "Script" } }, signatureFontFamily: "Script" }));

import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SigningView } from "@/lib/sign/service/signing";
import { computeProgress, type SignerLocale } from "@/lib/sign/client/signer-flow";

import { FieldLayer, type MyFieldView } from "./field-layer";
import { FieldList } from "./field-list";
import { InvalidLinkRoot, SignerRoot, type SignerMessages } from "./signer-root";
import { SignatureEditor } from "./signature-editor";
import { StickyBar } from "./sticky-bar";
import { readSignerMessages, SIGNER_LOCALES } from "./signer-test-messages";

const found = readSignerMessages();
const run = found ? describe : describe.skip;

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const all = (found ? Object.fromEntries(SIGNER_LOCALES.map((l) => [l, { Sign: { signer: found[l] } }])) : {}) as unknown as SignerMessages;

const fields: PlacedField[] = [
  { key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06, required: true },
  { key: "ini", type: "initials", role: "merchant", page: 0, x: 0.5, y: 0.8, w: 0.1, h: 0.04, required: true },
  { key: "tick", type: "checkbox", role: "merchant", page: 0, x: 0.1, y: 0.5, w: 0.03, h: 0.02, required: false },
  { key: "name", type: "name", role: "merchant", page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.03, required: false },
  { key: "theirs", type: "text", role: "director", page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03, required: true },
];

function view(over: Partial<SigningView> = {}): SigningView {
  return {
    state: "active",
    needsCode: false,
    needsConsent: false,
    consent: { text: "I agree to use electronic records and signatures.", version: "default-v1-en" },
    document: { title: "Merchant Agreement", reference: "MA-0001", pageCount: 2, locale: "en", expiresAt: "2026-10-20T00:00:00Z", message: "Please sign by Friday.", signInOrder: true, codeRequired: false },
    workspace: { name: "Kedai Runcit Ali", logoUrl: "https://example.test/logo.png" },
    signer: { name: "Ali bin Ahmad", roleKey: "merchant", kind: "signer", status: "viewed" },
    content: { fields, answers: {}, othersAnswers: { theirs: { text: "Director wrote this" } }, others: [{ name: "Siti", roleKey: "director", kind: "signer", status: "sent", orderNo: 2, signedAt: null }], missing: ["sig", "ini"] },
    ...over,
  };
}

function page(v: SigningView, locale: SignerLocale = "en", sessionOk = true) {
  return renderToStaticMarkup(<SignerRoot token={"t".repeat(40)} initialView={v} initialSessionOk={sessionOk} initialLocale={locale} messages={all} product="Halo" />);
}

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

run("the signing page, first paint", () => {
  it("shows the workspace, with its logo, and the document before anything else", () => {
    const html = page(view());
    expect(html).toContain('alt="Kedai Runcit Ali"');
    expect(html).toContain("Kedai Runcit Ali");
    expect(html).toContain("Merchant Agreement");
    expect(html).toContain("Please sign by Friday.");
    expect(html).toContain("Secured by Halo");
    expect(errors).toEqual([]);
  });

  it("asks for the code first when the document needs one, and shows no field", () => {
    const html = page(view({ state: "active", needsCode: true, needsConsent: true, content: null, document: { ...view().document, codeRequired: true } }));
    expect(html).toContain("Enter your code");
    expect(html).toMatch(/autocomplete="one-time-code"/i);
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(html).not.toContain("Tap to sign");
    expect(errors).toEqual([]);
  });

  it("shows the consent wording exactly as the server gave it, before the document", () => {
    const html = page(view({ needsConsent: true }));
    expect(html).toContain("I agree to use electronic records and signatures.");
    expect(html).toContain("Read the document first");
    expect(html).toContain("I do not want to sign");
    expect(errors).toEqual([]);
  });

  it("shows the document to fill in, with the bar, the field list and no download", () => {
    const html = page(view());
    expect(html).toContain("0 of 2 done");
    expect(html).toContain("Next field");
    expect(html).toContain("Finish");
    expect(html).toContain("Your fields");
    expect(html).not.toContain("Download signed PDF");
    expect(errors).toEqual([]);
  });

  it.each([
    ["signed", "You have signed"],
    ["sealing", "We are finishing your document"],
    ["completed", "The document is signed"],
    ["declined", "This document was not signed"],
    ["expired", "This link has expired"],
    ["voided", "This document was cancelled"],
    ["failed", "We are fixing a problem"],
    ["not_invited", "It is not your turn yet"],
  ] as const)("shows the %s end state", (state, words) => {
    const html = page(view({ state, signer: { ...view().signer, status: state === "signed" ? "signed" : "viewed" } }));
    expect(html).toContain(words);
    expect(html).not.toContain("Tap to sign");
    expect(errors).toEqual([]);
  });

  it("lists the other people, and whose turn it is, once signed", () => {
    const html = page(view({ state: "signed", signer: { ...view().signer, status: "signed" } }));
    expect(html).toContain("Siti");
    expect(html).toContain("Their turn now");
    expect(html).toContain("Thank you, Ali bin Ahmad.");
  });

  it("offers the signed copy only when completed and the person may fetch it", () => {
    const done = view({ state: "completed", document: { ...view().document, codeRequired: true } });
    expect(page(done, "en", true)).toContain("Download signed PDF");
    const without = page(done, "en", false);
    expect(without).not.toContain("Download signed PDF");
    expect(without).toContain("A signed copy was sent to your email address.");
  });

  it("names the workspace, and nothing of the sender, on an expired link", () => {
    expect(page(view({ state: "expired" }))).toContain("Ask Kedai Runcit Ali to send it again.");
  });

  it.each(SIGNER_LOCALES)("renders every screen in %s without a missing message", (locale) => {
    for (const v of [
      view({ needsCode: true, content: null }),
      view({ needsConsent: true }),
      view(),
      view({ state: "signed", signer: { ...view().signer, status: "signed" } }),
      view({ state: "sealing" }),
      view({ state: "completed" }),
      view({ state: "declined" }),
      view({ state: "expired" }),
      view({ state: "voided" }),
      view({ state: "failed" }),
      view({ state: "not_invited", content: null }),
    ]) {
      const html = page(v, locale);
      expect(html).toContain(`lang="${locale}"`);
      expect(html).not.toMatch(/Sign\.signer\./);
    }
    expect(errors).toEqual([]);
  });

  it("renders a link that is not valid, and a busy page, with no workspace and no document", () => {
    const invalid = renderToStaticMarkup(<InvalidLinkRoot initialLocale="ms" messages={all} product="Halo" />);
    expect(invalid).toContain("Pautan ini tidak sah");
    expect(invalid).not.toContain("<img");
    const busy = renderToStaticMarkup(<InvalidLinkRoot busy initialLocale="en" messages={all} product="Halo" />);
    expect(busy).toContain("Please wait a moment");
    expect(errors).toEqual([]);
  });
});

run("the pieces over the page", () => {
  const mine = (answers: Record<string, { image?: string; typed?: string; checked?: boolean }>): MyFieldView[] =>
    fields
      .filter((f) => f.role === "merchant" && f.type !== "name")
      .map((field) => ({ field, status: answers[field.key] ? "done" : field.required ? "todo" : "optional", input: answers[field.key], problemCode: null }));

  function withIntl(node: React.ReactNode, locale: SignerLocale = "en") {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={all[locale]} timeZone="UTC" onError={(e) => { throw e; }}>
        {node}
      </NextIntlClientProvider>,
    );
  }

  it("draws a box to tap for each field to do, and what is filled in", () => {
    const html = withIntl(
      <FieldLayer
        size={{ width: 360, height: 509 }}
        mine={mine({ sig: { image: PNG } })}
        system={[{ field: fields[3], text: "Ali bin Ahmad" }]}
        others={[{ field: fields[4], input: { text: "Director wrote this" } }]}
        highlightKey={null}
        onActivate={() => {}}
      />,
    );
    expect(html).toContain("Tap to add initials");
    expect(html).toContain("Director wrote this");
    expect(html).toContain("Ali bin Ahmad");
    expect(html).toContain(PNG);
    // the boxes are positioned in percentages of the page
    expect(html).toMatch(/left:[\d.]+%;top:[\d.]+%;width:[\d.]+%;height:[\d.]+%/);
    // every box says what it is and where it stands in words
    expect(html).toContain('aria-label="Signature: Done"');
    expect(html).toContain('aria-label="Initials: To do"');
  });

  it("marks a field the server turned down, with the reason", () => {
    const html = withIntl(
      <FieldLayer
        size={{ width: 360, height: 509 }}
        mine={[{ field: fields[0], status: "invalid", input: { typed: "Ali" }, problemCode: "bad_typed_signature" }]}
        system={[]}
        others={[]}
        highlightKey={null}
        onActivate={() => {}}
      />,
    );
    expect(html).toContain("Type your name or initials.");
    expect(html).toContain('aria-invalid="true"');
  });

  it("lists the fields with their state in words, and the ones filled in for the person", () => {
    const html = withIntl(<FieldList id="sign-fields" mine={mine({})} system={[fields[3]]} onJump={() => {}} />);
    expect(html).toContain("To do");
    expect(html).toContain("Optional");
    expect(html).toContain("Filled in for you");
    expect(html).toContain("Page 1");
  });

  it("keeps Finish switched off until nothing required is left", () => {
    const todo = withIntl(<StickyBar progress={computeProgress(fields.filter((f) => f.role === "merchant"), {})} saveState="idle" finishing={false} finishError={null} onNext={() => {}} onFinish={() => {}} />);
    expect(todo).toMatch(/disabled=""[^>]*>Finish<\/button>/);
    expect(todo).toContain("Next field");
    const ready = withIntl(
      <StickyBar progress={computeProgress(fields.filter((f) => f.role === "merchant"), { sig: { typed: "Ali" }, ini: { typed: "A" } })} saveState="saved" finishing={false} finishError={null} onNext={() => {}} onFinish={() => {}} />,
    );
    expect(ready).not.toContain("Next field");
    expect(ready).toContain("2 of 2 done");
    expect(ready).not.toMatch(/disabled=""[^>]*>Finish<\/button>/);
  });

  it("offers the three ways to sign, and the saved signature once there is one", () => {
    const fresh = withIntl(<SignatureEditor field={fields[0]} value={undefined} signerName="Ali bin Ahmad" adopted={null} onApply={() => {}} onClear={() => {}} />);
    expect(fresh).toContain("Draw");
    expect(fresh).toContain("Type");
    expect(fresh).toContain("Upload");
    expect(fresh).not.toContain("Use my signature");
    const again = withIntl(<SignatureEditor field={fields[1]} value={undefined} signerName="Ali bin Ahmad" adopted={{ mode: "type", typed: "Ali bin Ahmad" }} onApply={() => {}} onClear={() => {}} />);
    expect(again).toContain("Use my signature");
    // initials from the saved typed name
    expect(again).toContain("ABA");
  });
});
