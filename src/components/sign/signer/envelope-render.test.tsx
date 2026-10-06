import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An envelope's page for a signer (migration 171), rendered from a view with the page's real messages and this work package's English laid
// over them (the other languages are checked by envelope-signer-messages.test.ts once the message fragment is merged). Effects do not run
// under renderToStaticMarkup, so this is the first paint. The script font comes from next/font, which only works inside Next's compiler.

vi.mock("./signature-font", () => ({ signatureFont: { variable: "", style: { fontFamily: "Script" } }, signatureFontFamily: "Script" }));

import type { PlacedField } from "@/lib/sign/pdf/types";
import type { EnvelopeDocView, EnvelopeView, SigningView } from "@/lib/sign/service/signing";
import { scopeOf } from "@/lib/sign/client/scope";

import { EnvelopeBar, EnvelopeEnd, EnvelopeIntro } from "./envelope-bar";
import { SignerRoot, type SignerMessages } from "./signer-root";
import { readPageMessages } from "./signer-test-messages";
import { NextIntlClientProvider } from "next-intl";

type Tree = { [key: string]: unknown };

export const ENVELOPE_EN: Tree = {
  position: "Document {number} of {count}",
  listLabel: "The documents in this envelope",
  open: "Open {title}",
  notFinal: "Nothing is final until you finish the last document. Your answers are saved as you go.",
  next: "Next document",
  finish: "Finish",
  introTitle: "{count} documents to read and sign",
  introTitleFill: "{count} documents to complete",
  introBody: "You agree once, then go through the documents one after another and finish once at the end.",
  declineNote: "This stops all {count} documents of the envelope that are not yet fully signed.",
  state: { active: "To do", signed: "Signed", sealing: "Being sealed", completed: "Complete", declined: "Declined", expired: "Expired", voided: "Cancelled", failed: "Needs attention", not_invited: "Not your turn yet" },
  end: {
    signed: { title: "You have signed all {count} documents", body: "Thank you, {name}. Your part is done.", waiting: "We are waiting for the others. When everyone has signed, you will get one email with all the signed copies." },
    completed: { title: "All {count} documents are complete", body: "Everyone has signed. Download your signed copies below.", byEmail: "The signed copies were sent to your email address." },
    download: "Download {title}",
    downloadShort: "Download",
  },
};

function deep(into: Tree, extra: Tree): Tree {
  const out: Tree = { ...into };
  for (const [k, v] of Object.entries(extra)) out[k] = v && typeof v === "object" && out[k] && typeof out[k] === "object" ? deep(out[k] as Tree, v as Tree) : v;
  return out;
}

const found = readPageMessages();
const run = found ? describe : describe.skip;
const en = found ? (found.en as unknown as { Sign: { signer: Tree; signerForm: Tree } }).Sign : null;
const messages = (en ? { en: { Sign: { signer: deep(en.signer, { envelope: ENVELOPE_EN, decline: { title: "Do not sign?", body: "x" } }), signerForm: en.signerForm } } } : {}) as unknown as SignerMessages;

const fields: PlacedField[] = [
  { key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06, required: true },
  { key: "biz", type: "text", role: "merchant", page: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.03, required: true },
];

const docs = (states: [EnvelopeDocView["state"], EnvelopeDocView["state"], EnvelopeDocView["state"]]): EnvelopeDocView[] => [
  { id: "d1", position: 1, title: "Merchant Agreement", reference: "SGN-1", pageCount: 2, mode: "sign", state: states[0] },
  { id: "d2", position: 2, title: "Fee Schedule", reference: "SGN-2", pageCount: 1, mode: "sign", state: states[1] },
  { id: "d3", position: 3, title: "Data Terms", reference: "SGN-3", pageCount: 3, mode: "sign", state: states[2] },
];

const envelope = (over: Partial<EnvelopeView> = {}, states: [EnvelopeDocView["state"], EnvelopeDocView["state"], EnvelopeDocView["state"]] = ["signed", "active", "active"]): EnvelopeView => ({
  title: "Onboarding pack",
  reference: "ENV-2026-000007",
  count: 3,
  current: "d2",
  state: "active",
  documents: docs(states),
  ...over,
});

function view(over: Partial<SigningView> = {}): SigningView {
  return {
    state: "active",
    needsCode: false,
    needsConsent: false,
    consent: { text: "I agree to use electronic records and signatures.", version: "default-v1-en" },
    document: { title: "Fee Schedule", reference: "SGN-2", pageCount: 1, locale: "en", expiresAt: null, message: null, signInOrder: false, codeRequired: false },
    envelope: envelope(),
    workspace: { name: "Vircle", logoUrl: null },
    signer: { name: "Ali bin Ahmad", roleKey: "merchant", kind: "signer", status: "viewed" },
    content: { fields, answers: {}, othersAnswers: {}, others: [], missing: ["sig", "biz"] },
    ...over,
  };
}

const TOKEN = "t".repeat(40);
const page = (v: SigningView, sessionOk = true) => renderToStaticMarkup(<SignerRoot token={TOKEN} initialView={v} initialSessionOk={sessionOk} initialLocale="en" messages={messages} product="Halo" />);

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

run("the envelope on the signing page", () => {
  it("introduces the envelope before the person agrees: its title, how many documents, and which", () => {
    const html = page(view({ needsConsent: true, envelope: envelope({ current: "d1", documents: docs(["active", "active", "active"]) }) }));
    expect(html).toContain("Onboarding pack");
    expect(html).toContain("ENV-2026-000007");
    expect(html).toContain("3 documents to read and sign");
    expect(html).toContain("You agree once");
    for (const title of ["Merchant Agreement", "Fee Schedule", "Data Terms"]) expect(html).toContain(title);
    expect(errors).toEqual([]);
  });

  it("asks for the code under the envelope's title and names none of its documents", () => {
    const html = page(view({ needsCode: true, content: null, envelope: envelope({ documents: [] }) }), false);
    expect(html).toContain("Onboarding pack");
    expect(html).not.toContain("Merchant Agreement");
    expect(errors).toEqual([]);
  });

  it("frames a document with its place, the list of documents with states in words, and the promise that nothing is final yet", () => {
    const html = page(view());
    expect(html).toContain("Document 2 of 3");
    expect(html).toContain("The documents in this envelope");
    expect(html).toContain("Merchant Agreement");
    expect(html).toContain("Signed");
    expect(html).toContain("To do");
    expect(html).toContain("Nothing is final until you finish the last document.");
    // the document being worked on is marked as the current step; the done one is not a button, the other to-do one is
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Open Data Terms");
    expect(html).not.toContain("Open Merchant Agreement");
    expect(html).not.toContain("Open Fee Schedule");
    expect(errors).toEqual([]);
  });

  it("says Next document on a document that is not the last one still to do, and Finish on the last", () => {
    expect(page(view())).toContain("Next document");
    expect(page(view())).not.toContain(">Finish<");
    const last = page(view({ document: { ...view().document, title: "Data Terms" }, envelope: envelope({ current: "d3" }) }));
    expect(last).toContain(">Finish<");
    expect(last).not.toContain("Next document");
    expect(last).toContain("Document 3 of 3");
    // a document of its own has no such frame
    const plain = page(view({ envelope: undefined }));
    expect(plain).not.toContain("Document 2 of 3");
    expect(plain).toContain(">Finish<");
  });

  it("has the person's sitting end as ONE page: signed everything, waiting for the others", () => {
    const html = page(view({ state: "signed", content: null, envelope: envelope({ state: "signed" }, ["signed", "signed", "signed"]) }));
    expect(html).toContain("You have signed all 3 documents");
    expect(html).toContain("Thank you, Ali bin Ahmad.");
    expect(html).toContain("one email with all the signed copies");
    expect(html).not.toContain("Download");
    expect(errors).toEqual([]);
  });

  it("offers each signed copy for download once every document is complete, each with its own document in the address", () => {
    const html = page(view({ state: "completed", content: null, envelope: envelope({ state: "completed" }, ["completed", "completed", "completed"]) }));
    expect(html).toContain("All 3 documents are complete");
    for (const id of ["d1", "d2", "d3"]) expect(html).toContain(`/api/sign/public/${TOKEN}/file?doc=${id}&amp;download=1`);
    expect(html).toContain("Download Merchant Agreement");
    // without the code's session nothing is offered, and the page says the copies were sent by email
    const locked = page(view({ state: "completed", content: null, document: { ...view().document, codeRequired: true }, envelope: envelope({ state: "completed" }, ["completed", "completed", "completed"]) }), false);
    expect(locked).toContain("The signed copies were sent to your email address.");
    expect(locked).not.toContain("download=1");
  });
});

describe("the pieces", () => {
  const render = (node: React.ReactNode) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={{ Sign: { signer: { envelope: ENVELOPE_EN } } }} timeZone="UTC">
        {node}
      </NextIntlClientProvider>,
    );

  it("lists nothing of the documents before they are known, and numbers them after", () => {
    expect(render(<EnvelopeIntro envelope={envelope({ documents: [] })} />)).not.toContain("<ol");
    expect(render(<EnvelopeIntro envelope={envelope()} fill />)).toContain("3 documents to complete");
    expect(render(<EnvelopeBar envelope={envelope()} onGo={() => {}} />)).toContain("1.");
  });

  it("says every state in words, never by colour alone", () => {
    const all = render(<EnvelopeBar envelope={envelope({}, ["declined", "failed", "not_invited"])} onGo={() => {}} />);
    for (const word of ["Declined", "Needs attention", "Not your turn yet"]) expect(all).toContain(word);
    const done = render(<EnvelopeEnd envelope={envelope({ state: "signed" }, ["sealing", "completed", "signed"])} scope={scopeOf(TOKEN, "d1")} name="Ali" canDownload />);
    expect(done).toContain("Being sealed");
    expect(done).toContain(`/api/sign/public/${TOKEN}/file?doc=d2&amp;download=1`);
  });
});
