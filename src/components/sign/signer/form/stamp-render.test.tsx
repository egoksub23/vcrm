import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for the company stamp card and the document badges and counter of the form in parts. No DOM renderer exists in this repo, so
// what is checked is the first paint, from static markup, in every language with the page's real messages (next-intl throws on a missing
// one). What static markup cannot do is click: opening the card, typing and watching the preview change, "Use this stamp" (the canvas and
// the save) and the buttons are NOT exercised here. Their logic is in pure helpers with their own tests (client/stamp.test.ts,
// forms/stamp-and-files.test.ts); the picture itself was drawn and turned into a PNG in a real browser by hand, see docs/doc-sign-setup.md.

vi.mock("../signature-font", () => ({ signatureFont: { variable: "", style: { fontFamily: "Script" } }, signatureFontFamily: "Script" }));

import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import { stampInputs, stampSignature, stampSvg } from "@/lib/sign/client/stamp";
import type { AnswerMap, DataField, FormDefinition, L10n, SignerFormView } from "@/lib/sign/forms/types";

import type { SignerMessages } from "../signer-root";
import { readPageMessages, SIGNER_LOCALES } from "../signer-test-messages";
import { FormFlow, type FormFlowProps } from "./form-flow";
import { FormUiProvider } from "./form-ui";
import { StampChoice, type StampChoiceProps } from "./stamp-card";

const found = readPageMessages();
const run = found ? describe : describe.skip;
const all = (found ?? {}) as unknown as SignerMessages;

const L = (en: string, ms?: string): L10n => ({ en, ...(ms ? { ms } : {}) });
const field = (over: Partial<DataField> & Pick<DataField, "key" | "type" | "part">): DataField => ({ label: L(over.key), required: false, ...over });

const definition: FormDefinition = {
  version: 1,
  parts: [
    { key: "company", title: L("Company and tax"), role: "merchant" },
    { key: "docs", title: L("Documents"), role: "merchant" },
    { key: "signing", title: L("Review and sign"), role: "merchant" },
  ],
  fields: [
    field({ key: "business_type", type: "choice", part: "company", label: L("Type of business"), required: true, options: [{ value: "sdn_bhd", label: L("Sdn. Bhd.") }, { value: "sole_prop", label: L("Sole proprietor") }, { value: "other", label: L("Others") }] }),
    field({ key: "legal_name", type: "multiline", part: "company", label: L("Company legal name", "Nama sah syarikat"), required: true }),
    field({ key: "brn", type: "text", part: "company", label: L("Business registration no.", "No. pendaftaran perniagaan"), required: true, sensitive: true, format: "digits" }),
    field({ key: "brn_old", type: "text", part: "company", label: L("Old registration number (if any)"), format: "alnum_hyphen", visibleIf: { op: "eq", field: "business_type", value: "sdn_bhd" } }),
    field({ key: "form9", type: "file", part: "docs", label: L("Form 9"), required: true, accept: ["pdf", "jpg"], maxFiles: 3, visibleIf: { op: "eq", field: "business_type", value: "sdn_bhd" } }),
    field({ key: "form_d", type: "file", part: "docs", label: L("Form D"), required: true, accept: ["pdf"], visibleIf: { op: "eq", field: "business_type", value: "sole_prop" } }),
    field({ key: "bank", type: "file", part: "docs", label: L("Bank statement header"), required: true, accept: ["pdf", "jpg"] }),
    field({ key: "other_doc", type: "file", part: "docs", label: L("Registration document"), accept: ["pdf"], visibleIf: { op: "eq", field: "business_type", value: "other" } }),
    field({ key: "stamp", type: "image", part: "signing", label: L("Official company stamp"), stamp: { nameField: "legal_name", newNumberField: "brn", oldNumberField: "brn_old" } }),
  ],
};
const stampField = definition.fields[definition.fields.length - 1];

const file = (id: string, name: string) => ({ id, name, mime: "application/pdf", size: 800_000, sha256: "x" });
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function view(answers: Record<string, unknown> = {}): SignerFormView {
  return { definition, partKeys: ["company", "docs", "signing"], answers: answers as SignerFormView["answers"], unconfirmed: [], progress: [], ready: false };
}

const wrap = (node: React.ReactNode, locale: SignerLocale) => (
  <NextIntlClientProvider
    locale={locale}
    messages={all[locale]}
    timeZone="UTC"
    onError={(e) => {
      throw e;
    }}
  >
    <FormUiProvider value={{ locale }}>{node}</FormUiProvider>
  </NextIntlClientProvider>
);

function flow(part: string, answers: Record<string, unknown>, locale: SignerLocale = "en", props: Partial<FormFlowProps> = {}) {
  return renderToStaticMarkup(wrap(<FormFlow view={view(answers)} locale={locale} start={{ part }} onChange={() => {}} onReview={() => {}} reviewLocked onUpload={async () => {}} onRemoveUpload={async () => {}} {...props} />, locale));
}

const FULL: AnswerMap = { business_type: { text: "sdn_bhd" }, legal_name: { text: "Kedai Runcit Ali Sdn. Bhd." }, brn: { text: "202101012345" }, brn_old: { text: "123456-A" } };

function card(props: Partial<StampChoiceProps> = {}, answers: AnswerMap = FULL, locale: SignerLocale = "en") {
  return renderToStaticMarkup(
    wrap(
      <StampChoice field={stampField} id="stamp-1" definition={definition} answers={answers} picture={null} onUse={async () => true} onRemove={() => {}} onGoToField={() => {}} {...props}>
        <p>THE UPLOAD CONTROL</p>
      </StampChoice>,
      locale,
    ),
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

run("the two ways to give a stamp", () => {
  it("offers Upload your stamp and Create a stamp from your company details as two radio buttons in a group, and opens on the upload", () => {
    const html = card();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("How do you want to add your company stamp?");
    expect(html).toContain("Upload your stamp");
    expect(html).toContain("Create a stamp from your company details");
    expect([...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)]).toHaveLength(2);
    // one name, so the arrow keys move between them; the upload one is checked and the ordinary control is shown
    const names = new Set([...html.matchAll(/<input[^>]*type="radio"[^>]*name="([^"]+)"/g)].map((m) => m[1]));
    expect(names.size).toBe(1);
    expect(html).toMatch(/value="upload"[^>]*checked|checked[^>]*value="upload"/);
    expect(html).toContain("THE UPLOAD CONTROL");
    expect(html).not.toContain("data-stamp-card");
    expect(errors).toEqual([]);
  });

  it("leaves a field without the stamp option exactly as it was: no choice, just the control", () => {
    const { stamp: _stamp, ...plain } = stampField;
    void _stamp;
    const html = renderToStaticMarkup(
      wrap(
        <StampChoice field={plain} id="s" definition={definition} answers={FULL} picture={null} onUse={async () => true} onRemove={() => {}}>
          <p>THE UPLOAD CONTROL</p>
        </StampChoice>,
        "en",
      ),
    );
    expect(html).toBe("<p>THE UPLOAD CONTROL</p>");
  });

  it("is a group with a legend and the real label on the field's row, with the choice inside it, in every language", () => {
    for (const locale of SIGNER_LOCALES) {
      const html = flow("signing", { ...FULL }, locale);
      expect(html, locale).toContain("Official company stamp");
      expect(html, locale).toContain('role="radiogroup"');
      expect(html, locale).toContain("<fieldset");
      expect(html, locale).not.toMatch(/Sign\.signerForm|stamp\.way/);
    }
    expect(errors).toEqual([]);
  });
});

run("the create card", () => {
  it("says what to fill in first, with a button to each missing field, when the name and the number are missing", () => {
    const html = card({ initialWay: "create" }, { business_type: { text: "sdn_bhd" } });
    expect(html).toContain('data-stamp-card="needs"');
    expect(html).toContain("Fill in your company details first");
    expect(html).toContain("Go to: Company legal name");
    expect(html).toContain("Go to: Business registration no.");
    // the name comes first
    expect(html.indexOf("Company legal name")).toBeLessThan(html.indexOf("Business registration no."));
    expect(html).not.toContain("<img");
    expect(html).toContain("Choose another way");
    expect(html).not.toContain("Use this stamp");
  });

  it("names only what is still missing", () => {
    const html = card({ initialWay: "create" }, { ...FULL, brn: undefined });
    expect(html).toContain("Go to: Business registration no.");
    expect(html).not.toContain("Go to: Company legal name");
  });

  it("shows the labels, not buttons, in a preview where there is nowhere to go", () => {
    const html = card({ initialWay: "create", onGoToField: undefined }, { business_type: { text: "sdn_bhd" } });
    expect(html).not.toContain("Go to:");
    expect(html).toContain("Company legal name");
  });

  it("shows the stamp drawn from the answers, with alt text, the note, and the button", () => {
    const html = card({ initialWay: "create" });
    expect(html).toContain('data-stamp-card="preview"');
    expect(html).toContain("This is a digital imprint made from your company details.");
    expect(html).toContain("Use this stamp");
    expect(html).toContain("Choose another way");
    expect(html).toContain('alt="Preview of your company stamp: KEDAI RUNCIT ALI SDN. BHD., registration number 202101012345, old registration number 123456-A."');
    // the picture is the stamp of these answers: an SVG data URL that carries them
    const src = /<img src="(data:image\/svg\+xml[^"]+)"/.exec(html)![1].replace(/&amp;/g, "&");
    const svg = decodeURIComponent(src.slice(src.indexOf(",") + 1)).replace(/&#x27;/g, "'");
    expect(svg).toBe(stampSvg(stampInputs(definition, stampField.stamp!, FULL)));
    expect(svg).toContain("KEDAI RUNCIT ALI SDN. BHD.");
  });

  it("leaves the old number out of the alt text and the picture when there is none, or when it is not asked of this type of business", () => {
    const none = card({ initialWay: "create" }, { ...FULL, brn_old: undefined });
    expect(none).toContain('alt="Preview of your company stamp: KEDAI RUNCIT ALI SDN. BHD., registration number 202101012345."');
    const sole = card({ initialWay: "create" }, { ...FULL, business_type: { text: "sole_prop" } });
    expect(sole).not.toContain("old registration number");
  });

  it("warns, without hiding the stamp, when the registration number is not 12 digits", () => {
    const html = card({ initialWay: "create" }, { ...FULL, brn: { text: "12345" } });
    expect(html).toContain("A new registration number normally has 12 digits.");
    expect(html).toContain("Use this stamp");
    expect(card({ initialWay: "create" })).not.toContain("normally has 12 digits");
  });

  it("shows a saved stamp as a thumbnail with Created from your company details, and Replace and Remove / choose another way", () => {
    const made = stampSignature(stampInputs(definition, stampField.stamp!, FULL));
    const html = card({ initialWay: "create", picture: PNG, initialMadeFrom: made });
    expect(html).toContain('data-stamp-card="saved"');
    expect(html).toContain("Created from your company details");
    expect(html).toContain("Replace this stamp");
    expect(html).toContain("Remove / choose another way");
    expect(html).toContain(`<img src="${PNG}"`);
    expect(html).toContain('alt="Your company stamp, created from your company details."');
    expect(html).not.toContain("Use this stamp");
    expect(html).not.toContain("Your company details have changed");
  });

  it("tells a person whose details changed since the stamp was made, so they can replace it", () => {
    const html = card({ initialWay: "create", picture: PNG, initialMadeFrom: stampSignature({ name: "OLD NAME", newNumber: "1", oldNumber: "" }) });
    expect(html).toContain("Your company details have changed since you created this stamp.");
  });

  it("opens the card, for a picture uploaded earlier, as a preview: it is not a stamp made here", () => {
    const html = card({ initialWay: "create", picture: PNG });
    expect(html).toContain('data-stamp-card="preview"');
  });

  it("is worded in every language, with the same structure, and no raw key", () => {
    for (const locale of SIGNER_LOCALES) {
      const html = card({ initialWay: "create" }, FULL, locale);
      expect(html, locale).toContain('data-stamp-card="preview"');
      expect(html, locale).not.toMatch(/stamp\.(way|needs|alt|note|use)/);
      expect([...html.matchAll(/<button/g)].length, locale).toBe(2);
      expect(html, locale).toContain("<img");
      expect(html, locale).toMatch(/alt="[^"]*KEDAI RUNCIT ALI SDN\. BHD\.[^"]*202101012345[^"]*123456-A/);
      const needs = card({ initialWay: "create" }, {}, locale);
      expect(needs, locale).toContain('data-stamp-card="needs"');
      expect(needs, locale).toContain("<button");
    }
    expect(card({ initialWay: "create" }, FULL, "ms")).toContain("Guna cop ini");
    expect(card({ initialWay: "create" }, FULL, "zh")).toContain("使用此印章");
    expect(card({ initialWay: "create" }, FULL, "ko")).toContain("이 직인 사용");
    expect(errors).toEqual([]);
  });

  it("fits a 360 px screen: full-width stacked buttons, a preview that never grows past its box, wrapping text, 44 px targets", () => {
    const html = card({ initialWay: "create" });
    expect(html).toContain("max-w-64");
    expect(html).toContain("w-full");
    expect(html).toContain("flex-col");
    expect(html).toContain("h-11");
    expect(html).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/);
    // the radio cards stack on a phone and sit side by side from the small breakpoint
    expect(html).toContain("sm:grid-cols-2");
  });

  it("uses no Tailwind dark: variants (they do not work in this app): colours are tokens or light-dark() pairs", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["stamp-card.tsx", "field-row.tsx", "part-screen.tsx"]) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/["'\s]dark:/);
    }
    const html = card({ initialWay: "create" }, { ...FULL, brn: { text: "12345" } });
    expect(html).toContain("light-dark(");
  });
});

run("the stamp on the form's own screens", () => {
  it("shows the choice on the signing part for the stamp field, with its label", () => {
    const html = flow("signing", FULL);
    expect(html).toContain("Official company stamp");
    expect(html).toContain("Upload your stamp");
    expect(html).toContain("Create a stamp from your company details");
  });
});

run("documents say whether they are needed, and how many are added", () => {
  const files = (...names: string[]) => ({ files: names.map((n, i) => file(`f${i}`, n)) }) as SignerFormView["answers"][string];

  it("badges a document that depends on the type of business, one that is always needed, and one that is optional", () => {
    const sdn = flow("docs", { business_type: { text: "sdn_bhd" } });
    expect(sdn).toContain('data-document-badge="requiredForType"');
    expect(sdn).toContain("Required for your business type");
    expect(sdn).toContain('data-document-badge="required"');
    expect(sdn).toContain(">Required<");
    const other = flow("docs", { business_type: { text: "other" } });
    expect(other).toContain('data-document-badge="optional"');
    expect(other).toContain(">Optional<");
    // only the shown ones: Form 9 is a Sdn. Bhd.'s
    expect(other).not.toContain("Form 9");
    expect(sdn).toContain("Form 9");
    expect(sdn).not.toContain("Form D");
  });

  it("counts the required documents added in the part header, and the optional ones apart, for a part with several documents", () => {
    const none = flow("docs", { business_type: { text: "sdn_bhd" } });
    expect(none).toContain("data-document-progress");
    expect(none).toContain("0 of 2 required documents added");
    const one = flow("docs", { business_type: { text: "sdn_bhd" }, form9: files("form9.pdf") });
    expect(one).toContain("1 of 2 required documents added");
    const both = flow("docs", { business_type: { text: "sdn_bhd" }, form9: files("form9.pdf"), bank: files("bank.pdf") });
    expect(both).toContain("2 of 2 required documents added");
    const other = flow("docs", { business_type: { text: "other" }, other_doc: files("reg.pdf") });
    expect(other).toContain("0 of 1 required document added");
    expect(other).toContain("1 of 1 optional added");
  });

  it("shows no counter in a part with one document or none", () => {
    expect(flow("company", FULL)).not.toContain("data-document-progress");
    expect(flow("signing", FULL)).not.toContain("data-document-progress");
  });

  it("says the same in every language, with the numbers", () => {
    for (const locale of SIGNER_LOCALES) {
      const html = flow("docs", { business_type: { text: "sdn_bhd" }, form9: files("form9.pdf") }, locale);
      expect(html, locale).toContain("data-document-progress");
      expect(html, locale).not.toMatch(/document\.(badge|progress)/);
      const line = /data-document-progress[^>]*>([^<]*)</.exec(html)![1];
      expect(line, locale).toMatch(/1/);
      expect(line, locale).toMatch(/2/);
    }
    expect(flow("docs", { business_type: { text: "sdn_bhd" } }, "ms")).toContain("Wajib untuk jenis perniagaan anda");
    expect(flow("docs", { business_type: { text: "sdn_bhd" } }, "zh")).toContain("您的企业类型必填");
    expect(flow("docs", { business_type: { text: "sdn_bhd" } }, "ko")).toContain("사업 유형에 필수");
    expect(errors).toEqual([]);
  });
});
