import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render checks for a form WITHOUT a signature (migration 169) on the signing page: the consent, the overview, the review before
// "Submit" and every end screen say submit and form, never sign; an agreement renders as it always did. The page's real messages are
// used, with the English of this work package laid over them (the other languages are checked by form-only-messages.test.ts once the
// message fragment is merged). Effects do not run under renderToStaticMarkup, so this is the first paint. The script font comes from
// next/font, which only works inside Next's compiler, so it is replaced here.

vi.mock("./signature-font", () => ({ signatureFont: { variable: "", style: { fontFamily: "Script" } }, signatureFontFamily: "Script" }));

import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { DataField, FormDefinition, L10n, SignerFormView } from "@/lib/sign/forms/types";
import type { SigningView } from "@/lib/sign/service/signing";

import { SubmitReview } from "./form/submit-review";
import { SignerRoot, type SignerMessages } from "./signer-root";
import { readPageMessages } from "./signer-test-messages";

type Tree = { [key: string]: unknown };

const OVERLAY: { signer: Tree; signerForm: Tree } = {
  signer: {
    consent: { titleForm: "Submit electronically" },
    fill: { declineForm: "I do not want to fill this in" },
    decline: { titleForm: "Do not complete this form?", bodyForm: "x", confirmForm: "Decline to complete" },
    end: {
      sealingForm: { title: "We are recording your submission", body: "Everyone has submitted.", slow: "Slow." },
      completedForm: { title: "Your submission is recorded", body: "Everyone has submitted.", download: "Download the record", view: "View the record", byEmail: "A copy of the record was sent to your email address." },
      declinedForm: { title: "This form was not completed", you: "You chose not to complete it. The sender has been told.", other: "Someone chose not to complete it." },
      notInvitedForm: { title: "It is not your turn yet", body: "Someone needs to finish before you." },
    },
    others: { titleForm: "Who is filling this in", invitedForm: "Has not finished yet" },
  },
  signerForm: {
    final: { reviewSubmit: "Review and submit", readyReviewSubmit: "Check your answers, then submit." },
    end: { submitted: { title: "Thank you, your details were sent", thanks: "Thank you, {name}.", next: "You do not need to do anything else.", waiting: "We are waiting for the others to finish." } },
    submitReview: {
      title: "Review and submit",
      parts: "Your answers, part by part",
      body: "Check your answers.",
      change: "Change",
      changePart: "Change the part {part}",
      picture: "A picture was attached",
      notAnswered: "Not answered",
      sensitiveNote: "Details marked private are shown hidden here.",
      back: "Back to the parts",
      submit: "Submit",
      submitting: "Submitting...",
      afterwards: "You cannot change your answers once you submit.",
    },
  },
};

function deep(into: Tree, extra: Tree): Tree {
  const out: Tree = { ...into };
  for (const [k, v] of Object.entries(extra)) out[k] = v && typeof v === "object" && out[k] && typeof out[k] === "object" ? deep(out[k] as Tree, v as Tree) : v;
  return out;
}

const found = readPageMessages();
const run = found ? describe : describe.skip;
const en = found ? ((found.en as unknown as { Sign: { signer: Tree; signerForm: Tree } }).Sign) : null;
const messages = (en
  ? { en: { Sign: { signer: deep(en.signer, OVERLAY.signer), signerForm: deep(en.signerForm, OVERLAY.signerForm) } } }
  : {}) as unknown as SignerMessages;

const L = (text: string, ms?: string): L10n => ({ en: text, ...(ms ? { ms } : {}) });
const field = (over: Partial<DataField> & Pick<DataField, "key" | "type" | "part">): DataField => ({ label: L(over.key), required: false, ...over });

const definition: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company details"), role: "applicant" },
    { key: "einvoice", title: L("E-invoice"), role: "applicant" },
  ],
  fields: [
    field({ key: "legal", type: "text", part: "company", label: L("Legal name"), required: true }),
    field({ key: "tin", type: "text", part: "einvoice", label: L("Tax identification number"), required: true, sensitive: true }),
    field({ key: "sst", type: "yesno", part: "einvoice", label: L("Registered for SST") }),
    field({ key: "extract", type: "file", part: "einvoice", label: L("SSM extract"), accept: ["pdf"] }),
    field({ key: "notes", type: "multiline", part: "einvoice", label: L("Notes") }),
  ],
};

const formView = (over: Partial<SignerFormView> = {}): SignerFormView => ({
  definition,
  partKeys: ["company", "einvoice"],
  answers: {
    legal: { text: "Kedai Runcit Ali Sdn Bhd" },
    tin: { text: "C20881234567" },
    sst: { checked: true },
    extract: { files: [{ id: "f1", name: "ssm-extract.pdf", mime: "application/pdf", size: 2048, sha256: "a".repeat(64) }] },
  },
  unconfirmed: [],
  progress: [
    { key: "company", state: "done", done: 1, total: 1, visible: 1 },
    { key: "einvoice", state: "done", done: 1, total: 1, visible: 4 },
  ],
  ready: true,
  ...over,
});

function view(over: Partial<SigningView> = {}, form: SignerFormView | null = formView()): SigningView {
  return {
    state: "active",
    needsCode: false,
    needsConsent: false,
    consent: { text: "I agree to use electronic records to submit this form.", version: "default-form-v1-en" },
    document: { title: "E-invoice details", reference: "SGN-2026-000777", pageCount: 1, locale: "en", expiresAt: null, message: null, signInOrder: false, codeRequired: false, mode: "form" },
    workspace: { name: "Vircle", logoUrl: null },
    signer: { name: "Ali bin Ahmad", roleKey: "applicant", kind: "filler", status: "viewed" },
    content: { fields: [], answers: {}, othersAnswers: {}, others: [], missing: [], form },
    ...over,
  };
}

const page = (v: SigningView, locale: SignerLocale = "en") => renderToStaticMarkup(<SignerRoot token={"t".repeat(40)} initialView={v} initialSessionOk initialLocale={locale} messages={messages} product="Halo" />);

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

run("agreeing to submit", () => {
  it("asks to agree to submit, offers no document to read first, and words the way out as not filling in", () => {
    const html = page(view({ needsConsent: true }));
    expect(html).toContain("Submit electronically");
    expect(html).toContain("I agree to use electronic records to submit this form.");
    expect(html).not.toContain("Read the document first");
    expect(html).not.toContain("Sign electronically");
    expect(html).toContain("I do not want to fill this in");
    expect(html).not.toContain("I do not want to sign");
    expect(errors).toEqual([]);
  });

  it("keeps the agreement's consent screen as it was", () => {
    const html = page(view({ needsConsent: true, document: { ...view().document, mode: "sign" }, consent: { text: "I agree to use electronic records and signatures.", version: "default-v1-en" } }));
    expect(html).toContain("Sign electronically");
    expect(html).toContain("Read the document first");
    expect(html).toContain("I do not want to sign");
    expect(html).not.toContain("Submit electronically");
  });
});

run("the form's overview", () => {
  it("ends in Review and submit, not Review and sign, and never shows the document", () => {
    const html = page(view());
    expect(html).toContain("E-invoice details");
    expect(html).toContain("Review and submit");
    expect(html).toContain("Check your answers, then submit.");
    expect(html).not.toContain("Review and sign");
    expect(html).not.toContain("Your fields");
    expect(html).toContain("I do not want to fill this in");
    expect(errors).toEqual([]);
  });

  it("says how many parts to finish before Submit while one is open", () => {
    const html = page(view({}, formView({ answers: {}, ready: false, progress: [] })));
    expect(html).toContain("Review and submit");
    expect(html).toContain("to unlock Submit");
  });

  it("keeps an agreement's overview as it was", () => {
    const html = page(view({ document: { ...view().document, mode: "sign" }, signer: { name: "Ali", roleKey: "applicant", kind: "signer", status: "viewed" } }));
    expect(html).toContain("Review and sign");
    expect(html).not.toContain("Review and submit");
  });
});

describe("the review before Submit", () => {
  const html = (over: Partial<SignerFormView> = {}, locale: SignerLocale = "en") =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={(messages as unknown as Record<string, Tree>)[locale]} timeZone="UTC">
        <SubmitReview title="E-invoice details" form={formView(over)} locale={locale} onBack={() => {}} onEditPart={() => {}} onSubmit={async () => ({ ok: true, value: undefined })} />
      </NextIntlClientProvider>,
    );

  const live = found ? it : it.skip;

  live("shows every answer by part, with a way back to each part and a Submit button", () => {
    const out = html();
    expect(out).toContain("Review and submit");
    expect(out).toContain("1. ");
    expect(out).toContain("Company details");
    expect(out).toContain("Kedai Runcit Ali Sdn Bhd");
    expect(out).toContain("Yes");
    expect(out).toContain("ssm-extract.pdf");
    expect(out).toContain("Change the part Company details");
    expect(out).toContain("Change the part E-invoice");
    expect(out).toContain("Back to the parts");
    expect(out).toContain(">Submit<");
    expect(out).toContain("You cannot change your answers once you submit.");
    expect(errors).toEqual([]);
  });

  live("shows a sensitive answer masked, says so, and names a question nobody answered", () => {
    const out = html();
    expect(out).toContain("•••• 4567");
    expect(out).not.toContain("C20881234567");
    expect(out).toContain("Details marked private are shown hidden here.");
    expect(out).toContain("Not answered"); // the notes
  });

  live("shows only the person's own parts", () => {
    const out = html({ partKeys: ["company"] });
    expect(out).toContain("Company details");
    expect(out).not.toContain("Registered for SST");
  });
});

run("the end of the form", () => {
  it("thanks the person who submitted, and says who the others are while it waits", () => {
    const done = page(view({ state: "signed", signer: { name: "Ali bin Ahmad", roleKey: "applicant", kind: "filler", status: "signed" } }));
    expect(done).toContain("Thank you, your details were sent");
    expect(done).toContain("Thank you, Ali bin Ahmad.");
    expect(done).not.toContain("You have signed");
    const waiting = page(
      view({
        state: "signed",
        signer: { name: "Ali bin Ahmad", roleKey: "applicant", kind: "filler", status: "signed" },
        content: { fields: [], answers: {}, othersAnswers: {}, others: [{ name: "Siti", roleKey: "accounts", kind: "filler", status: "sent", orderNo: 2, signedAt: null }], missing: [], form: null },
      }),
    );
    expect(waiting).toContain("We are waiting for the others to finish.");
    expect(waiting).toContain("Who is filling this in");
    expect(waiting).toContain("Has not finished yet");
    expect(waiting).toContain("Siti");
  });

  it("says the record is being made, then that it is done with a link to it", () => {
    const sealing = page(view({ state: "sealing" }));
    expect(sealing).toContain("We are recording your submission");
    expect(sealing).not.toContain("We are finishing your document");
    const completed = page(view({ state: "completed" }));
    expect(completed).toContain("Your submission is recorded");
    expect(completed).toContain("Download the record");
    expect(completed).toContain("View the record");
    expect(completed).not.toContain("Download signed PDF");
  });

  it("words a refusal and a turn that has not come as a form", () => {
    expect(page(view({ state: "declined", signer: { name: "Ali", roleKey: "applicant", kind: "filler", status: "declined" } }))).toContain("This form was not completed");
    expect(page(view({ state: "not_invited" }))).toContain("It is not your turn yet");
    expect(page(view({ state: "not_invited" }))).not.toContain("Someone needs to sign before you");
  });

  it("leaves an agreement's end screens as they were", () => {
    const sign = { ...view().document, mode: "sign" as const };
    expect(page(view({ state: "sealing", document: sign }))).toContain("We are finishing your document");
    expect(page(view({ state: "completed", document: sign }))).toContain("Download signed PDF");
  });
});
