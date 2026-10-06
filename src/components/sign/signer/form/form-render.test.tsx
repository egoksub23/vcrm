import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render smoke tests for the form in parts: every screen renders from a view, in every language, with the
// page's real messages and next-intl set to throw on a missing one, and none shows a raw key. Effects do not run
// under renderToStaticMarkup, so what is checked is what the first paint holds. The script font comes from
// next/font, which only works inside Next's compiler, so it is replaced here.

vi.mock("../signature-font", () => ({ signatureFont: { variable: "", style: { fontFamily: "Script" } }, signatureFontFamily: "Script" }));

import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import { PROBLEM_CODES } from "@/lib/sign/client/signer-form";
import type { DataField, FormDefinition, L10n, SignerFormView } from "@/lib/sign/forms/types";
import type { SigningView } from "@/lib/sign/service/signing";

import { InvalidLinkRoot, SignerRoot, type SignerMessages } from "../signer-root";
import { readPageMessages, SIGNER_LOCALES } from "../signer-test-messages";
import { FormFlow, type FormFlowProps } from "./form-flow";
import { ReviewPanel } from "./review-panel";

const found = readPageMessages();
const run = found ? describe : describe.skip;
const all = (found ?? {}) as unknown as SignerMessages;

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });
const field = (over: Partial<DataField> & Pick<DataField, "key" | "type" | "part">): DataField => ({ label: L(over.key), required: false, ...over });

const definition: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company and tax", "Syarikat dan cukai"), description: L("Tell us about the company."), role: "merchant" },
    { key: "contact", title: L("Contacts"), role: "merchant" },
    { key: "docs", title: L("Documents"), role: "merchant" },
    { key: "terms", title: L("Terms"), role: "merchant" },
    { key: "bank", title: L("Bank"), role: "finance" },
  ],
  fields: [
    field({ key: "legalName", type: "text", part: "company", label: L("Legal name", "Nama sah"), required: true, help: L("As in your SSM registration") }),
    field({ key: "bizType", type: "choice", part: "company", label: L("Company type"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.") }, { value: "sole", label: L("Sole proprietor") }] }),
    field({ key: "state", type: "choice", part: "company", label: L("State"), required: false, options: ["Johor", "Kedah", "Kelantan", "Melaka", "Pahang", "Perak"].map((s) => ({ value: s.toLowerCase(), label: L(s) })) }),
    field({ key: "taxType", type: "choice", part: "company", label: L("Tax type"), options: [{ value: "sst", label: L("SST") }, { value: "na", label: L("None") }] }),
    field({ key: "taxPct", type: "number", part: "company", label: L("Tax percentage"), required: false, requiredIf: { op: "eq", field: "taxType", value: "sst" }, visibleIf: { op: "eq", field: "taxType", value: "sst" } }),
    field({ key: "about", type: "multiline", part: "company", label: L("Business activity") }),
    field({ key: "email", type: "email", part: "contact", label: L("Invoice email"), required: true }),
    field({ key: "phone", type: "phone", part: "contact", label: L("Phone"), required: true }),
    field({ key: "since", type: "date", part: "contact", label: L("Trading since") }),
    field({ key: "ref", type: "text", part: "contact", label: L("Reference number"), locked: true }),
    field({ key: "msic", type: "list", part: "contact", label: L("MSIC codes"), required: true, itemFormat: "digits", itemLength: 5, maxItems: 4 }),
    field({ key: "channels", type: "multichoice", part: "contact", label: L("Channels"), options: [{ value: "web", label: L("Website") }, { value: "shop", label: L("Shop") }] }),
    field({ key: "pep", type: "yesno", part: "contact", label: L("Is anyone a political figure?") }),
    field({ key: "form9", type: "file", part: "docs", label: L("Form 9 and Form 49"), required: true, accept: ["pdf", "jpg"], maxMb: 5, maxFiles: 3 }),
    field({ key: "stamp", type: "image", part: "docs", label: L("Company stamp") }),
    field({ key: "agree", type: "acknowledge", part: "terms", label: L("Merchant terms"), text: L("You agree to the merchant terms.\nFees are charged monthly.") }),
    field({ key: "account", type: "text", part: "bank", label: L("Account number"), required: true }),
  ],
};

const file = (id: string, name: string, size = 800_000) => ({ id, name, mime: "application/pdf", size, sha256: "x" });

function view(over: Partial<SignerFormView> = {}): SignerFormView {
  return {
    definition,
    partKeys: ["company", "contact", "docs", "terms"],
    answers: { legalName: { text: "Kedai Runcit Ali" }, bizType: { text: "sdn_bhd" } },
    unconfirmed: [],
    progress: [{ key: "company", state: "in_progress", done: 2, total: 2, visible: 5, lastSavedAt: "2026-10-06T09:00:00Z" }],
    ready: false,
    ...over,
  };
}

/** The opening tag of the first control whose attributes match. */
const tagOf = (html: string, pattern: RegExp): string => [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map((m) => m[0]).find((t) => pattern.test(t)) ?? "";

/** A form with nothing answered yet. */
const blank = (): SignerFormView => view({ answers: {}, progress: [] });

function flow(props: Partial<FormFlowProps> = {}, locale: SignerLocale = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={all[locale]}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      <FormFlow view={view()} locale={locale} onChange={() => {}} onReview={() => {}} reviewLocked={true} {...props} />
    </NextIntlClientProvider>,
  );
}

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

run("the overview", () => {
  it("shows the parts, how many are done, the bar, and where to continue", () => {
    const html = flow({ title: "Your merchant application", view: blank() });
    expect(html).toContain("Your merchant application");
    expect(html).toContain("0 of 4 parts done");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="\d+"/);
    for (const title of ["Company and tax", "Contacts", "Documents", "Terms"]) expect(html).toContain(title);
    expect(html).toContain("Continue: Company and tax");
    // the bank belongs to someone else
    expect(html).not.toContain("Bank");
    expect(errors).toEqual([]);
  });

  it("counts the parts that are done, and continues with the first that is not", () => {
    // the company part is done in the sample answers
    const html = flow();
    expect(html).toContain("1 of 4 parts done");
    expect(html).toContain("Continue: Contacts");
    expect(html).toContain("Finish 3 more parts to unlock signing");
  });

  it("says where each part stands in words, and how many answers it has", () => {
    const html = flow({
      view: view({ answers: { legalName: { text: "K" }, bizType: { text: "sole" }, email: { text: "a@b.co" } } }),
    });
    expect(html).toContain("Done");
    expect(html).toContain("In progress");
    expect(html).toContain("Not started");
    expect(html).toContain("1 of 3 answered");
  });

  it("keeps Review and sign locked and says how many parts are left", () => {
    const html = flow({ view: blank() });
    expect(html).toContain("Review and sign");
    expect(html).toContain("Locked");
    expect(html).toContain("Finish 4 more parts to unlock signing");
    expect(html).toMatch(/aria-disabled="true"/);
  });

  it("opens Review and sign when every required answer is in, and offers it as the main button", () => {
    const answers = {
      legalName: { text: "K" },
      bizType: { text: "sole" },
      email: { text: "a@b.co" },
      phone: { text: "+60123456789" },
      msic: { list: ["47111"] },
      form9: { files: [file("f1", "form9.pdf")] },
      agree: { checked: true },
    } as SignerFormView["answers"];
    const html = flow({ view: view({ answers, ready: true }), reviewLocked: false });
    expect(html).toContain("Ready");
    expect(html).toContain("Check the answers on the form, then sign.");
    expect(html).not.toMatch(/aria-disabled="true"/);
    expect(html).not.toContain("Continue:");
    expect(html).toContain("4 of 4 parts done");
  });

  it("asks a person who only fills in to submit, not to sign", () => {
    const html = flow({ finalAction: "submit", view: blank() });
    expect(html).toContain("Submit your answers");
    expect(html).not.toContain("Review and sign");
    expect(html).toContain("Finish 4 more parts to unlock Submit");
  });

  it("says it is a preview, and says what went wrong above the form", () => {
    const html = flow({ preview: true, notice: "Some required answers are still empty." });
    expect(html).toContain("This is a preview. Nothing you enter here is saved or sent.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Some required answers are still empty.");
  });

  it("uses the form's own text in the page's language", () => {
    const html = flow({ view: blank() }, "ms");
    expect(html).toContain("Syarikat dan cukai");
    expect(html).toContain("Teruskan: Syarikat dan cukai");
  });
});

run("a part", () => {
  const part = (key: string, extra: Partial<FormFlowProps> = {}) => flow({ start: { part: key }, ...extra });

  it("shows its title, description and fields with real labels, help and required marks", () => {
    const html = part("company", { view: blank() });
    expect(html).toContain("Part 1 of 4");
    expect(html).toContain("Company and tax");
    expect(html).toContain("Tell us about the company.");
    expect(html).toContain("Legal name");
    expect(html).toContain("As in your SSM registration");
    expect(html).toContain("(required)");
    expect(html).toContain("(optional)");
    expect(html).toContain("Save and next part");
    expect(html).toContain("Back to overview");
    expect(html).toContain("2 required answers left in this part");
    // what is stored is shown in the field
    expect(part("company")).toContain("Kedai Runcit Ali");
    expect(part("company")).toContain("This part is complete.");
  });

  it("shows a field that depends on another only when that answer says so", () => {
    expect(part("company")).not.toContain("Tax percentage");
    const html = part("company", { view: view({ answers: { taxType: { text: "sst" } } }) });
    expect(html).toContain("Tax percentage");
  });

  it("shows a few options as rows to tap and many as a menu", () => {
    const html = part("company");
    expect(tagOf(html, /value="sdn_bhd"/)).toContain('type="radio"');
    expect(tagOf(html, /value="sdn_bhd"/)).toContain('checked=""');
    expect(tagOf(html, /value="sole"/)).not.toContain("checked");
    expect(html).toContain("Sole proprietor");
    expect(html).toContain("<select");
    expect(html).toContain("Choose...");
    expect(html).toContain("Kelantan");
  });

  it("uses the keyboard each kind of answer needs", () => {
    const html = part("contact");
    expect(html).toMatch(/type="email"[^>]*inputMode="email"|inputMode="email"[^>]*type="email"/i);
    expect(html).toMatch(/type="tel"/);
    expect(html).toMatch(/type="date"/);
    expect(html).toContain("012-345 6789");
    expect(html).toContain("Start with 0 or +60");
    expect(html).toContain('autoComplete="email"');
    expect(part("company", { view: view({ answers: { taxType: { text: "sst" } } }) })).toMatch(/inputMode="decimal"/i);
    const text = part("company");
    expect(text).toContain("<textarea");
  });

  it("shows a locked field as text, a list with its limits and yes or no, ticks and a menu", () => {
    const html = part("contact", { view: view({ answers: { ref: { text: "REF-001" }, msic: { list: ["47111", "47211"] }, pep: { checked: false }, channels: { choices: ["shop"] } } }) });
    expect(html).toContain("REF-001");
    expect(html).toContain("This was filled in for you. It cannot be changed here.");
    expect(html).toContain('value="47111"');
    expect(html).toContain('value="47211"');
    expect(html).toContain("Add another");
    expect(html).toContain("Digits only");
    expect(html).toContain("Up to 4 entries");
    expect(html).toContain("Remove entry 1");
    expect(html).toContain("Yes");
    expect(html).toContain("No");
    expect(tagOf(html, /value="shop"/)).toContain('checked=""');
    expect(tagOf(html, /value="web"/)).not.toContain("checked");
  });

  it("lists the files uploaded with their names and sizes, and says what is accepted", () => {
    const html = part("docs", { view: view({ answers: { form9: { files: [file("f1", "form-9.pdf", 840_000), file("f2", "form-49.jpg", 1_300_000)] } } }), onUpload: async () => {}, onRemoveUpload: async () => {} });
    expect(html).toContain("form-9.pdf");
    expect(html).toContain("820 KB");
    expect(html).toContain("1.2 MB");
    expect(html).toContain("Remove form-9.pdf");
    expect(html).toContain("Add another file");
    expect(html).toContain("Take a photo");
    expect(html).toContain("Accepted: PDF, JPG. Up to 5 MB each.");
    expect(html).toContain("2 of up to 3 files added.");
    expect(html).toContain('accept=".pdf,application/pdf,.jpg,.jpeg,image/jpeg"');
    // the company stamp
    expect(html).toContain("Choose a picture");
  });

  it("shows the picture the person added", () => {
    const html = part("docs", { view: view({ answers: { stamp: { image: PNG, mime: "image/png" } } }) });
    expect(html).toContain(PNG);
    expect(html).toContain("Choose another picture");
    expect(html).toContain("Remove picture");
  });

  it("shows a text to read and a box to accept it", () => {
    const html = part("terms");
    expect(html).toContain("You agree to the merchant terms.");
    expect(html).toContain("I have read and accept");
    expect(html).toContain('role="region"');
    expect(html).toContain("(required)");
  });

  it("says an answer came from the contact, and offers to confirm the part", () => {
    const html = part("company", { onConfirmPart: () => {}, view: view({ unconfirmed: ["legalName"] }) });
    expect(html).toContain("From our records, please check");
    expect(html).toContain("Confirm this part");
    expect(part("company", { view: view({ unconfirmed: ["legalName"] }) })).not.toContain("Confirm this part");
  });

  it("marks an answer the server turned down, in words, tied to its field", () => {
    const html = part("contact", { rejected: { email: { code: "bad_email" }, msic: { code: "too_many_items", detail: "4" }, phone: { code: "never_seen" } } });
    expect(html).toContain("Enter an email address like name@example.com.");
    expect(html).toContain("You can add up to 4 entries.");
    expect(html).toContain("This could not be saved. Please change it and try again.");
    expect(html).toContain("Some answers need a change. They are marked below.");
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/aria-describedby="[^"]*-error"/);
  });

  it("says when a part is complete, and goes to the overview from the last one", () => {
    const html = part("terms", { view: view({ answers: { agree: { checked: true } } }) });
    expect(html).toContain("This part is complete.");
    expect(html).toContain("Save and go to overview");
  });

  it("opens a part named by the page, at a field", () => {
    expect(part("contact", { start: { part: "contact", field: "email" } })).toContain("Invoice email");
    // a part that is not this person's opens the overview
    expect(part("bank", { view: blank() })).toContain("0 of 4 parts done");
  });

  it("makes every control reachable: a label for each, none without", () => {
    const html = part("contact");
    // a ticked or picked row is inside its own label; every other control has a label that points at it, or its own
    const controls = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)].map((m) => m[0]).filter((tag) => !/type="(file|radio|checkbox)"/.test(tag));
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const tag of controls) {
      const id = /\bid="([^"]+)"/.exec(tag)?.[1];
      expect(/aria-label=/.test(tag) || (id !== undefined && html.includes(`for="${id}"`)), tag).toBe(true);
    }
  });
});

run("every screen, in every language", () => {
  it.each(SIGNER_LOCALES)("renders the overview and every part in %s with no missing message", (locale) => {
    const v = view({
      answers: { legalName: { text: "K" }, taxType: { text: "sst" }, ref: { text: "R" }, msic: { list: ["1"] }, form9: { files: [file("a", "a.pdf")] }, stamp: { image: PNG, mime: "image/png" } },
      unconfirmed: ["legalName"],
    });
    const common = { view: v, onUpload: async () => {}, onRemoveUpload: async () => {}, onConfirmPart: () => {}, saveState: "saved" as const, rejected: { email: { code: "bad_email" }, form9: { code: "file_too_large", detail: "5" } }, notice: "x" };
    for (const finalAction of ["review", "submit"] as const) {
      const html = flow({ ...common, finalAction, preview: true }, locale);
      expect(html).not.toMatch(/Sign\.signerForm/);
    }
    for (const key of definition.parts.map((p) => p.key).filter((k) => k !== "bank")) {
      const html = flow({ ...common, start: { part: key } }, locale);
      expect(html).not.toMatch(/Sign\.signerForm/);
    }
    expect(errors).toEqual([]);
  });

  it.each(SIGNER_LOCALES)("words every code a field can be turned down for, in %s", (locale) => {
    const rejected = Object.fromEntries(
      PROBLEM_CODES.map((code, i) => [["legalName", "email", "phone", "msic", "form9", "agree"][i % 6] + "", { code, detail: "5" }]),
    );
    for (const key of ["company", "contact", "docs", "terms"]) expect(() => flow({ start: { part: key }, rejected }, locale)).not.toThrow();
  });
});

run("the review step", () => {
  function panel(review: React.ComponentProps<typeof ReviewPanel>["review"], locale: SignerLocale = "en") {
    return renderToStaticMarkup(
      <NextIntlClientProvider
        locale={locale}
        messages={all[locale]}
        timeZone="UTC"
        onError={(e) => {
          throw e;
        }}
      >
        <ReviewPanel review={review} form={view()} locale={locale} onChangeAnswer={() => {}} onOpenAnswer={() => {}} onRetry={() => {}} />
      </NextIntlClientProvider>,
    );
  }

  it("says the answers are printed, and offers the way back", () => {
    const html = panel({ status: "ready", fitProblems: [] });
    expect(html).toContain("Check your answers");
    expect(html).toContain("Change an answer");
    expect(html).not.toContain('role="alert"');
  });

  it("names each answer that is too long for where it prints, and opens its part", () => {
    const html = panel({ status: "ready", fitProblems: [{ field: "legalName", placement: "p1" }, { field: "legalName", placement: "p2" }, { field: "about", placement: "p3" }] });
    expect(html).toContain("2 answers are too long to print");
    expect(html).toContain("This answer is too long for where it prints: Legal name. Shorten it.");
    expect(html).toContain("This answer is too long for where it prints: Business activity. Shorten it.");
    expect(html).toContain("Change this answer: Legal name");
    expect(html).toContain('role="alert"');
  });

  it("says when the answers are being put on the document, and when that failed", () => {
    expect(panel({ status: "loading" })).toContain("Putting your answers on the document...");
    const failed = panel({ status: "error" });
    expect(failed).toContain("We could not put your answers on the document.");
    expect(failed).toContain("Try again");
  });

  it.each(SIGNER_LOCALES)("renders in %s", (locale) => {
    for (const review of [{ status: "idle" }, { status: "loading" }, { status: "error" }, { status: "ready", fitProblems: [{ field: "legalName", placement: "p1" }] }] as const) panel(review as never, locale);
    expect(errors).toEqual([]);
  });
});

run("the live page", () => {
  const signerView = (over: Partial<SigningView> = {}, form: SignerFormView | null = view()): SigningView => ({
    state: "active",
    needsCode: false,
    needsConsent: false,
    consent: { text: "I agree.", version: "v1" },
    document: { title: "Merchant Application", reference: null, pageCount: 2, locale: "en", expiresAt: null, message: null, signInOrder: false, codeRequired: false },
    workspace: { name: "Kedai Runcit Ali", logoUrl: null },
    signer: { name: "Ali bin Ahmad", roleKey: "merchant", kind: "signer", status: "viewed" },
    content: {
      fields: [{ key: "sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.06, required: true }],
      answers: {},
      othersAnswers: {},
      others: [],
      missing: ["sig"],
      form,
    },
    ...over,
  });
  const page = (v: SigningView, locale: SignerLocale = "en") => renderToStaticMarkup(<SignerRoot token={"t".repeat(40)} initialView={v} initialSessionOk initialLocale={locale} messages={all} product="Halo" />);

  it("opens a form document at the overview, not at the document", () => {
    const html = page(signerView({}, blank()));
    expect(html).toContain("Merchant Application");
    expect(html).toContain("0 of 4 parts done");
    expect(html).toContain("Review and sign");
    expect(html).toContain("I do not want to sign");
    // no sticky bar of the document step, no field list
    expect(html).not.toContain("Your fields");
    expect(html).not.toContain("Next field");
  });

  it("goes straight to the document for a signer who has no part, and for a document with no form", () => {
    for (const form of [null, view({ partKeys: [] })]) {
      const html = page(signerView({}, form));
      expect(html).toContain("Your fields");
      expect(html).toContain("0 of 1 done");
      expect(html).not.toContain("Review and sign");
    }
  });

  it("gives a person who only fills in a Submit, never a sign step", () => {
    const html = page(signerView({ signer: { name: "Siti", roleKey: "finance", kind: "filler", status: "viewed" } }, view({ partKeys: ["terms"] })));
    expect(html).toContain("Submit your answers");
    expect(html).not.toContain("Review and sign");
  });

  it("thanks a filler in words made for them, not 'you have signed'", () => {
    const html = page(signerView({ state: "signed", signer: { name: "Siti", roleKey: "finance", kind: "filler", status: "signed" } }));
    expect(html).toContain("Your answers are sent");
    expect(html).toContain("Thank you, Siti.");
    expect(html).toContain("You do not need to do anything else.");
    expect(html).not.toContain("You have signed");
    // a signer still hears that they signed
    expect(page(signerView({ state: "signed", signer: { name: "Ali", roleKey: "merchant", kind: "signer", status: "signed" } }))).toContain("You have signed");
  });

  it.each(SIGNER_LOCALES)("renders in %s, form and end screens, with no missing message", (locale) => {
    for (const v of [
      signerView(),
      signerView({}, null),
      signerView({ signer: { name: "Siti", roleKey: "finance", kind: "filler", status: "viewed" } }, view({ partKeys: ["terms"] })),
      signerView({ state: "signed", signer: { name: "Siti", roleKey: "finance", kind: "filler", status: "signed" } }),
    ]) {
      const html = page(v, locale);
      expect(html).toContain(`lang="${locale}"`);
      expect(html).not.toMatch(/Sign\.signer(Form)?\./);
    }
    expect(renderToStaticMarkup(<InvalidLinkRoot initialLocale={locale} messages={all} product="Halo" />)).toContain(`lang="${locale}"`);
    expect(errors).toEqual([]);
  });
});
