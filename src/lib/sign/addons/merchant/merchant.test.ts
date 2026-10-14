import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PDFDocument } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";

import {
  boundValues,
  checkDataAnswer,
  fieldRequired,
  fieldVisible,
  fitProblems,
  formSendProblems,
  listProblems,
  sensitiveProblems,
  missingFormRequired,
  roleProgress,
  staticFitProblems,
  validateForm,
  type AnswerMap,
  type DataAnswerInput,
  type DataField,
  type FormValue,
} from "../../forms";
import { SYSTEM_LIST_KEYS } from "../../lists/keys";
import { SYSTEM_LISTS } from "../../lists/system-lists";
import { A4, scribblePng } from "../../pdf/fixtures";
import { freezeBase, stampFields, staticValues } from "../../pdf/stamp";
import type { FieldValue, PlacedField } from "../../pdf/types";
import { MAX_STATIC_TEXT, SENDER_ROLE, validateFields, validateRoles } from "../../rules";
import { SignError } from "../../service/errors";
import { assertFixedTextFits } from "../../service/send";
import { MERCHANT_PLACEMENTS_V2, MERCHANT_PLACEMENTS_V3, merchantAddon } from "../merchant";
import { resolvedWithSystemLists } from "../fixtures";
import { DEFAULT_COMMERCIAL_TERMS, DEFAULT_FEE_LINES, DEFAULT_KEY_POINTS, DEFAULT_KEY_TERMS, KEY_TERMS_MAX_POINTS, commercialTermsText, keyTermsText } from "./default-terms";
import { DIRECTOR_ROLE, FINANCE_ROLE, LEGACY_TERM_HEADINGS, LIST_FIELDS, MERCHANT_FORM as SHIPPED_FORM, MERCHANT_FORM_V1, MERCHANT_FORM_V2, MERCHANT_FORM_V3, MERCHANT_ROLE, MERCHANT_ROLES, SENSITIVE_FIELDS, merchantForm } from "./form";
import { DOCUMENT_ROWS, MERCHANT_PLACEMENTS, PART5, buildMerchantLayout } from "./layout";
import { buildMerchantAssets, renderMerchantPdf, summarize, summarySha256 } from "./render";

// What a document carries: the form the add-on ships (its choices name shared lists) with the lists' items copied in, as a template version
// stores it. Everything below that fills in or prints an answer runs on this; the shipped form itself is checked in "generation 2".
const MERCHANT_FORM = resolvedWithSystemLists(SHIPPED_FORM);

const DIR = path.join(process.cwd(), "src", "lib", "sign", "addons", "merchant");
const PDF_FILE = path.join(DIR, "assets", "merchant-application.pdf");
const SUMMARY_FILE = path.join(DIR, "assets", "merchant-application.layout.json");

// `UPDATE_MERCHANT_TEMPLATE=1 npx vitest run src/lib/sign/addons/merchant` rebuilds the two committed files first
// (the same thing scripts/build-merchant-template.ts does).
beforeAll(async () => {
  if (process.env.UPDATE_MERCHANT_TEMPLATE === "1") {
    const { pdf, summaryJson } = await buildMerchantAssets();
    writeFileSync(PDF_FILE, pdf);
    writeFileSync(SUMMARY_FILE, summaryJson);
  }
});

const committedPdf = () => new Uint8Array(readFileSync(PDF_FILE));
const placements = MERCHANT_PLACEMENTS;

describe("the template file and its layout cannot drift", () => {
  it("regenerates, in memory, the same layout that is committed", () => {
    const summary = summarize(buildMerchantLayout());
    const committed = JSON.parse(readFileSync(SUMMARY_FILE, "utf8"));
    // the whole summary, placements included: a change to the layout shows here until the files are rebuilt
    expect(JSON.parse(JSON.stringify(summary))).toEqual(committed);
  });

  it("commits a PDF made from that layout, with the page size and count the layout says", async () => {
    const layout = buildMerchantLayout();
    const doc = await PDFDocument.load(committedPdf(), { updateMetadata: false });
    expect(doc.getSubject()).toBe(`layout:${summarySha256(summarize(layout))}`);
    expect(doc.getPageCount()).toBe(layout.pageCount);
    expect(layout.pageCount).toBeGreaterThanOrEqual(3);
    expect(layout.pageCount).toBeLessThanOrEqual(4);
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBeCloseTo(A4.w, 1);
      expect(page.getHeight()).toBeCloseTo(A4.h, 1);
    }
  });

  it("draws the same pages again (the fonts carry every character and every label fits its column)", async () => {
    const again = await renderMerchantPdf();
    const doc = await PDFDocument.load(again);
    expect(doc.getPageCount()).toBe(buildMerchantLayout().pageCount);
    expect(again.length).toBeLessThan(400 * 1024);
  });

  it("puts every placement exactly on a rectangle that was drawn", () => {
    const layout = buildMerchantLayout();
    const W = layout.pageSize.w;
    const H = layout.pageSize.h;
    const rects = layout.ops.filter((o) => o.k === "rect");
    for (const p of placements) {
      const hit = rects.some((r) => r.k === "rect" && r.page === p.page && Math.abs(r.x / W - p.x) < 0.0006 && Math.abs(r.y / H - p.y) < 0.0006 && Math.abs(r.w / W - p.w) < 0.0006 && Math.abs(r.h / H - p.h) < 0.0006);
      expect(hit, `${p.key} is not on a drawn box`).toBe(true);
    }
  });

  it("has unique placement keys, none of them the key of a data field", () => {
    const keys = placements.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    const dataKeys = new Set(MERCHANT_FORM.fields.map((f) => f.key));
    expect(keys.some((k) => dataKeys.has(k))).toBe(false);
  });
});

describe("the form is sound and follows Appendix A", () => {
  it("passes the shared validation with its roles and placements, and the layout rules", () => {
    expect(validateRoles(MERCHANT_ROLES)).toEqual([]);
    expect(validateFields(placements, MERCHANT_ROLES, buildMerchantLayout().pageCount)).toEqual([]);
    expect(validateForm(MERCHANT_FORM, MERCHANT_ROLES, placements)).toEqual([]);
  });

  it("also passes when the bank part is given to the finance filler", () => {
    const form = resolvedWithSystemLists(merchantForm({ bankRole: "finance" }));
    expect(form.parts.find((p) => p.key === "bank")?.role).toBe(FINANCE_ROLE);
    expect(validateForm(form, MERCHANT_ROLES, placements)).toEqual([]);
    // the finance person must then be named; by default nobody is needed for that role
    expect(formSendProblems(form, [{ role_key: MERCHANT_ROLE }, { role_key: DIRECTOR_ROLE }])).toEqual([{ code: "part_without_person", part: "bank", role: FINANCE_ROLE }]);
    expect(formSendProblems(MERCHANT_FORM, [{ role_key: MERCHANT_ROLE }, { role_key: DIRECTOR_ROLE }])).toEqual([]);
  });

  it("has the six parts, the merchant holding all of them, and a director who only countersigns", () => {
    expect(MERCHANT_FORM.parts.map((p) => p.key)).toEqual(["company", "contacts", "bank", "documents", "terms", "signing"]);
    expect(MERCHANT_FORM.parts.every((p) => p.role === MERCHANT_ROLE)).toBe(true);
    expect(MERCHANT_ROLES.map((r) => [r.key, r.kind])).toEqual([
      ["merchant", "signer"],
      ["finance", "filler"],
      ["director", "signer"],
    ]);
    const director = placements.filter((p) => p.role === DIRECTOR_ROLE);
    expect(director.map((p) => p.type).sort()).toEqual(["date_signed", "name", "signature"]);
    expect(director.every((p) => p.page === buildMerchantLayout().pageCount - 1)).toBe(true);
    const merchant = placements.filter((p) => p.role === MERCHANT_ROLE);
    expect(merchant.map((p) => p.type).sort()).toEqual(["date_signed", "name", "signature"]);
  });

  const field = (k: string): DataField => MERCHANT_FORM.fields.find((f) => f.key === k)!;
  const text = (t: string): FormValue => ({ text: t });

  it("asks the SST details only of a merchant who pays SST", () => {
    for (const k of ["sst_tax_type", "sst_rate", "sst_no"]) {
      expect(fieldVisible(MERCHANT_FORM, field(k), {}), k).toBe(false);
      expect(fieldVisible(MERCHANT_FORM, field(k), { sst_payer: text("no") }), k).toBe(false);
      expect(fieldRequired(MERCHANT_FORM, field(k), { sst_payer: text("no") }), k).toBe(false);
      expect(fieldVisible(MERCHANT_FORM, field(k), { sst_payer: text("yes") }), k).toBe(true);
      expect(fieldRequired(MERCHANT_FORM, field(k), { sst_payer: text("yes") }), k).toBe(true);
    }
    // the question itself is always asked, and required
    expect(fieldRequired(MERCHANT_FORM, field("sst_payer"), {})).toBe(true);
  });

  it("asks for the documents of the type of business", () => {
    const need = (type: string) =>
      MERCHANT_FORM.fields
        .filter((f) => f.type === "file" && fieldRequired(MERCHANT_FORM, f, { business_type: text(type) }))
        .map((f) => f.key)
        .sort();
    expect(need("sdn_bhd")).toEqual(["doc_bank_statement", "doc_form49", "doc_form9", "doc_owner_id", "premise_pictures"]);
    // "Bhd." is not a type of business any more: it asks for nothing of its own
    expect(need("bhd")).toEqual(["doc_bank_statement", "doc_owner_id", "premise_pictures"]);
    expect(need("society_coop")).toEqual(["doc_bank_statement", "doc_minutes", "doc_owner_id", "premise_pictures"]);
    expect(need("sole_prop")).toEqual(["doc_bank_statement", "doc_form_d", "doc_owner_id", "premise_pictures"]);
    expect(need("partnership")).toEqual(need("sole_prop"));
    // before the type is chosen only the documents that are always needed are asked
    expect(need("")).toEqual(["doc_bank_statement", "doc_owner_id", "premise_pictures"]);
    expect(field("premise_pictures")).toMatchObject({ minFiles: 1, maxFiles: 3 });
  });

  it("keeps the trading name optional and checks the shapes of the answers", () => {
    expect(field("trading_name").required).toBe(false);
    const ok = (k: string, input: DataAnswerInput) => checkDataAnswer(field(k), input);
    expect(ok("brn", { text: "201901012345" })).toMatchObject({ ok: true });
    expect(ok("brn", { text: "2019-01-012345" })).toMatchObject({ ok: false, code: "format_digits" });
    expect(ok("tin", { text: "C2584563200" })).toMatchObject({ ok: true });
    expect(ok("postcode", { text: "50450" })).toMatchObject({ ok: true });
    expect(ok("postcode", { text: "5045" })).toMatchObject({ ok: false, code: "format_postcode_my" });
    expect(ok("company_phone", { text: "012 345 6789" })).toEqual({ ok: true, value: { text: "+60123456789" } });
    expect(ok("contact_email", { text: "Siti@Example.com" })).toEqual({ ok: true, value: { text: "siti@example.com" } });
    expect(ok("contact_email", { text: "not an email" })).toMatchObject({ ok: false, code: "bad_email" });
    expect(ok("msic_codes", { list: ["47111", "47211"] })).toMatchObject({ ok: true });
    // the codes are picked from the shared MSIC list, so a code that is not in it (too short, too long, not digits, not a class) is "not an option"
    for (const bad of ["4711", "471112", "47x11", "00000"]) expect(ok("msic_codes", { list: [bad] }), bad).toMatchObject({ ok: false, code: "not_an_option" });
    expect(ok("msic_codes", { list: (field("msic_codes").options ?? []).slice(0, 11).map((o) => o.value) })).toMatchObject({ ok: false, code: "too_many_items" });
    expect(ok("state", { text: "selangor" })).toMatchObject({ ok: true });
    expect(ok("state", { text: "Atlantis" })).toMatchObject({ ok: false, code: "not_an_option" });
    expect(ok("bank_account", { text: "5123 4567" })).toMatchObject({ ok: false });
    expect(ok("bank_swift", { text: "MBBEMYKL" })).toMatchObject({ ok: true });
    expect(ok("bank_swift", { text: "mbbe" })).toMatchObject({ ok: false });
    expect(ok("terms_accepted", { checked: true })).toEqual({ ok: true, value: { checked: true } });
    expect(ok("terms_accepted", { checked: false })).toEqual({ ok: true, value: null });
  });

  it("lists the 16 states and territories, and Malaysia as the default country", () => {
    expect(field("state").options).toHaveLength(16);
    expect(field("country")).toMatchObject({ defaultValue: "MY" });
    expect(field("country").options?.[0].value).toBe("MY");
    expect(field("msic_codes")).toMatchObject({ maxItems: 10, itemFormat: "digits", itemLength: 5 });
  });

  it("maps the contact person's name, the company and an email to contact fields", () => {
    const mapped = Object.fromEntries(MERCHANT_FORM.fields.filter((f) => f.contactField).map((f) => [f.key, f.contactField]));
    expect(mapped).toEqual({ legal_name: "company", contact_name: "name", contact_email: "email" });
  });

  it("is worded in English, Bahasa Melayu, Chinese and Korean, with English to fall back on", () => {
    for (const f of MERCHANT_FORM.fields) {
      for (const lang of ["en", "ms", "zh", "ko"] as const) expect(f.label[lang]?.trim(), `${f.key} label ${lang}`).toBeTruthy();
      if (f.help) expect(f.help.ms?.trim(), `${f.key} help ms`).toBeTruthy();
      if (f.text) expect(f.text.ms?.trim()).toBeTruthy();
    }
    for (const p of MERCHANT_FORM.parts) for (const lang of ["en", "ms", "zh", "ko"] as const) expect(p.title[lang]?.trim()).toBeTruthy();
    for (const f of MERCHANT_FORM.fields) {
      for (const o of f.options ?? []) {
        expect(o.label.en.trim()).toBeTruthy();
        // proper names (the banks) read the same in every language; everything else has Bahasa Melayu
        // and so do the tax rates (6%, 8%, 10%)
        if ((f.key !== "bank_name" && f.key !== "sst_rate") || o.value === "other") expect(o.label.ms?.trim(), `${f.key}/${o.value}`).toBeTruthy();
      }
    }
  });

  it("starts with every required field unanswered, in the merchant's six parts", () => {
    const progress = roleProgress(MERCHANT_FORM, MERCHANT_ROLE, {});
    expect(progress.map((p) => p.state)).toEqual(Array(6).fill("not_started"));
    const missing = missingFormRequired(MERCHANT_FORM, MERCHANT_ROLE, {}).map((f) => f.key);
    expect(missing).toContain("legal_name");
    expect(missing).not.toContain("trading_name");
    expect(missing).not.toContain("company_stamp");
    // nothing conditional is asked before the answer that decides it
    for (const k of ["sst_tax_type", "sst_rate", "sst_no", "business_codes", "msic_codes", "doc_minutes"]) expect(missing, k).not.toContain(k);
    expect(missing).toContain("sst_payer");
  });
});

// ---- the real engine ---------------------------------------------------------------------------------------------------

/** Uploaded files, as the stored answer holds them: only the names are ever printed. */
const uploaded = (...names: string[]): FormValue => ({ files: names.map((name, i) => ({ id: `file-${i}`, name, mime: "application/pdf", size: 2048, sha256: "0".repeat(64), path: `x/${name}` })) });

/** A made-up company. No real merchant, person, number or bank account is used anywhere in this repository. */
const SAMPLE: Record<string, FormValue> = {
  legal_name: { text: "KEDAI RUNCIT CONTOH JAYA ENTERPRISE SDN. BHD. (FORMERLY CONTOH TRADING)" },
  trading_name: { text: "Kedai Contoh Jaya" },
  business_type: { text: "sdn_bhd" },
  brn: { text: "202001000001" },
  brn_old: { text: "123456-A" },
  einvoice_phase: { text: "phase_3" },
  tin: { text: "C0000000001" },
  sst_payer: { text: "yes" },
  sst_tax_type: { text: "service_tax" },
  sst_rate: { text: "8" },
  sst_no: { text: "B16-0000-00000001" },
  msic_codes: { list: ["47111", "47211", "56101"] },
  address: { text: "No. 1, Jalan Contoh 1/1, Taman Contoh Indah, Kawasan Perindustrian Contoh" },
  city: { text: "Petaling Jaya" },
  postcode: { text: "47800" },
  state: { text: "selangor" },
  country: { text: "MY" },
  company_phone: { text: "+60312345678" },
  contact_name: { text: "Contoh Binti Ahmad" },
  contact_phone: { text: "+60123456789" },
  contact_email: { text: "contoh@example.test" },
  ops_name: { text: "Siti Binti Contoh" },
  ops_email: { text: "operasi@example.test" },
  finance_name: { text: "Ali Bin Contoh" },
  finance_email: { text: "kewangan@example.test" },
  einvoice_email: { text: "einvoice@example.test" },
  bank_name: { text: "maybank" },
  bank_account: { text: "514000000001" },
  bank_holder: { text: "KEDAI RUNCIT CONTOH JAYA ENTERPRISE SDN. BHD." },
  bank_branch: { text: "Petaling Jaya" },
  bank_swift: { text: "MBBEMYKL" },
  finance_contact: { text: "Ali Bin Contoh" },
  terms_accepted: { checked: true },
  signer_designation: { text: "Pengarah" },
  // a Sdn. Bhd.'s documents: the longest names a merchant could plausibly give (a long one, one with an accent) among ordinary ones
  doc_form9: uploaded("form9.pdf"),
  doc_form49: uploaded("form49-page1.pdf", "form49-page2.pdf"),
  doc_bank_statement: uploaded("maybank-statement-header.pdf"),
  doc_owner_id: uploaded("director-1-front.jpg", "director-1-back.jpg", "scan-of-the-identity-card-of-the-second-director-of-the-company-in-high-resolution-final-version.jpg", "salinan-kad-pengenalan-pengarah-kedua-édition-2026.jpg"),
  premise_pictures: uploaded("shopfront.jpg", "inside.jpg"),
};

async function withImages(): Promise<{ answers: AnswerMap; image: FieldValue["image"] }> {
  const png = await scribblePng();
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  return { answers: { ...SAMPLE, company_stamp: { image: dataUrl, mime: "image/png" } }, image: { bytes: png, mime: "image/png" } };
}

/** What the engine is given at sealing: bound answers, the sender's fixed text, and each signer's own marks. */
async function valuesFor(locale: "en" | "ms") {
  const { answers, image } = await withImages();
  const bound = boundValues(placements, MERCHANT_FORM, answers, locale);
  const fixed = staticValues(
    placements.filter((p) => !p.data),
    { fw_no: "FW-0001" },
  );
  const signed: Record<string, FieldValue> = {
    p_sign_merchant: { image },
    p_name_merchant: { text: "Contoh Binti Ahmad" },
    p_date_merchant: { at: new Date("2026-10-06T08:00:00Z") },
    p_sign_director: { image },
    p_name_director: { text: "Pengarah Contoh" },
    p_date_director: { at: new Date("2026-10-07T08:00:00Z") },
  };
  return { answers, bound, values: { ...bound, ...fixed, ...signed } };
}

describe("on the real engine", () => {
  // the placements a complete application (a Sdn. Bhd. that pays SST) leaves empty: the four types of business that were not chosen, the
  // "No" of the SST question, the Business code (only a sole proprietor or a partnership gives one), the documents of the other types of business (Form D, the minutes, the registration document of "others") and the two "other" boxes,
  // which are hidden while their rule does not hold
  const EMPTY = ["p_bank_name_other", "p_business_codes", "p_business_type_is_other", "p_business_type_is_partnership", "p_business_type_is_sole_prop", "p_business_type_is_society_coop", "p_business_type_other", "p_doc_form_d", "p_doc_minutes", "p_doc_registration_other", "p_sst_payer_is_no"];

  it("prints a complete set of answers without a single warning, and every value lands on a placement", async () => {
    const { values } = await valuesFor("en");
    const result = await stampFields(committedPdf(), placements, values, { locale: "en", timeZone: "Asia/Kuala_Lumpur" });
    expect(result.warnings).toEqual([]);
    const known = new Set(placements.map((p) => p.key));
    expect(Object.keys(values).every((k) => known.has(k))).toBe(true);
    const empty = placements.filter((p) => !values[p.key]).map((p) => p.key).sort();
    expect(empty).toEqual([...EMPTY].sort());
    expect(Object.keys(values)).toHaveLength(placements.length - EMPTY.length);
    if (process.env.MERCHANT_SAMPLE_DIR) {
      mkdirSync(process.env.MERCHANT_SAMPLE_DIR, { recursive: true });
      writeFileSync(path.join(process.env.MERCHANT_SAMPLE_DIR, "sample-en.pdf"), result.bytes);
    }
  });

  it("prints choices in the language of the document: Bahasa Melayu labels, and the right tick", async () => {
    const en = boundValues(placements, MERCHANT_FORM, (await withImages()).answers, "en");
    const ms = boundValues(placements, MERCHANT_FORM, (await withImages()).answers, "ms");
    expect(en.p_einvoice_phase.text).toBe("Phase 3: above RM5 million to RM25 million");
    expect(ms.p_einvoice_phase.text).toBe("Fasa 3: melebihi RM5 juta hingga RM25 juta");
    expect(en.p_sst_tax_type.text).toBe("Service tax");
    expect(ms.p_sst_tax_type.text).toBe("Cukai perkhidmatan");
    expect(en.p_sst_rate.text).toBe("8%");
    expect(ms.p_sst_payer_is_yes).toEqual({ checked: true });
    expect(ms.p_sst_payer_is_no).toBeUndefined();
    expect(ms.p_country.text).toBe("Malaysia");
    expect(ms.p_msic_codes.text).toBe("47111, 47211, 56101");
    expect(ms.p_business_type_is_sdn_bhd).toEqual({ checked: true });
    expect(ms.p_business_type_is_society_coop).toBeUndefined();
    expect(ms.p_terms_accepted).toEqual({ checked: true });
    expect(ms.p_company_stamp?.image?.mime).toBe("image/png");
    const { values } = await valuesFor("ms");
    const stamped = await stampFields(committedPdf(), placements, values, { locale: "ms", timeZone: "Asia/Kuala_Lumpur" });
    expect(stamped.warnings).toEqual([]);
    if (process.env.MERCHANT_SAMPLE_DIR) writeFileSync(path.join(process.env.MERCHANT_SAMPLE_DIR, "sample-ms.pdf"), stamped.bytes);
  });

  it("hides what is not asked: the SST details of a merchant who does not pay SST, the 'other' boxes", async () => {
    const { answers } = await withImages();
    // answers left over from a time the merchant said Yes are not printed once they say No
    const notSst: AnswerMap = { ...answers, sst_payer: { text: "no" } };
    const bound = boundValues(placements, MERCHANT_FORM, notSst, "en");
    expect(bound.p_sst_payer_is_no).toEqual({ checked: true });
    expect(bound.p_sst_payer_is_yes).toBeUndefined();
    for (const k of ["p_sst_tax_type", "p_sst_rate", "p_sst_no"]) expect(bound[k], k).toBeUndefined();
  });

  it("fits realistic answers: a legal name on two lines, an address on three", async () => {
    const { answers } = await withImages();
    const long: AnswerMap = {
      ...answers,
      legal_name: { text: "PERNIAGAAN DAN PERKHIDMATAN CONTOH BERSAUDARA MALAYSIA SDN. BHD. (DIKENALI SEBELUM INI SEBAGAI KEDAI RUNCIT CONTOH JAYA ENTERPRISE DAN RAKAN-RAKAN)" },
      address: { text: "Lot 12345, Tingkat 3, Menara Contoh Perdana, No. 88, Jalan Contoh Utama 12/34, Pusat Perdagangan Contoh Maju, Kawasan Perindustrian Ringan Contoh Jaya Fasa 2" },
    };
    expect(await fitProblems(committedPdf(), placements, MERCHANT_FORM, answers, "en")).toEqual([]);
    expect(await fitProblems(committedPdf(), placements, MERCHANT_FORM, long, "en")).toEqual([]);
    expect(await fitProblems(committedPdf(), placements, MERCHANT_FORM, long, "ms")).toEqual([]);
  });

  it("tells which answer is too long for its box (text_truncated)", async () => {
    const { answers } = await withImages();
    const tooLong: AnswerMap = {
      ...answers,
      legal_name: { text: Array.from({ length: 40 }, () => "PERNIAGAAN CONTOH").join(" ") },
      address: { text: Array.from({ length: 40 }, () => "Jalan Contoh Utama").join(" ") },
    };
    // the shared check offers each as the field to shorten
    const problems = await fitProblems(committedPdf(), placements, MERCHANT_FORM, tooLong, "en");
    expect(problems.map((p) => p.field).sort()).toEqual(["address", "legal_name"]);
    expect(problems.map((p) => p.placement).sort()).toEqual(["p_address", "p_legal_name"]);
    // and the engine's own warning, on the placement
    const values = boundValues(placements, MERCHANT_FORM, tooLong, "en");
    const stamped = await stampFields(committedPdf(), placements.filter((p) => p.data), values, { locale: "en" });
    expect(stamped.warnings.filter((w) => w.code === "text_truncated").map((w) => w.field).sort()).toEqual(["p_address", "p_legal_name"]);
  });

  it("keeps the sender's fixed text inside its boxes: the defaults fit, and so does real wording of a normal length", async () => {
    expect(await staticFitProblems(committedPdf(), placements)).toEqual([]);
    const reworded = placements.map((p) =>
      p.key === "p_key_terms"
        ? { ...p, text: keyTermsText(DEFAULT_KEY_POINTS.map((k) => ({ ...k, text: "The Merchant appoints the Partner to collect payments on its behalf under the agreed terms, and agrees to follow the Partner's operating rules as updated from time to time with notice." }))) }
        : p.key === "p_commercial_terms"
          ? { ...p, text: commercialTermsText(DEFAULT_FEE_LINES.map((l) => ({ ...l, text: "1.20% per transaction, minimum RM0.50" }))) }
          : p,
    );
    expect(await staticFitProblems(committedPdf(), reworded)).toEqual([]);
    const tooMuch = placements.map((p) => (p.key === "p_key_terms" ? { ...p, text: Array.from({ length: 60 }, (_, i) => `${i + 1}. Wording.`).join("\n") } : p));
    expect(await staticFitProblems(committedPdf(), tooMuch)).toEqual(["p_key_terms"]);
  });

  it("describes the same template in the add-on manifest", () => {
    const t = merchantAddon.templates[0];
    expect(t.name).toBe("Merchant Application");
    expect(t.fields).toBe(MERCHANT_PLACEMENTS);
    expect(t.form).toBe(SHIPPED_FORM);
    expect(t.roles).toBe(MERCHANT_ROLES);
    expect(t.defaults).toEqual({ code_required: false, sign_in_order: false, locale: "en", expiry_days: 30, reminder_days: [3, 7] });
    expect(merchantAddon.category).toMatchObject({ key: "merchant_agreements", name: "Merchant agreements" });
  });
});

// ---- generation 2 (add-on 2.0): shared option lists and sensitive answers ---------------------------------------------------------

describe("generation 2 of the form: shared lists and sensitive answers", () => {
  const authored = (k: string): DataField => MERCHANT_FORM_V2.fields.find((f) => f.key === k)!;
  const old = (k: string): DataField => MERCHANT_FORM_V1.fields.find((f) => f.key === k)!;

  it("names a shared list for each choice that has one, and carries no typed-in options beside it", () => {
    for (const [key, list] of Object.entries(LIST_FIELDS)) {
      expect(authored(key), key).toMatchObject({ optionList: list });
      expect(authored(key).options, key).toBeUndefined();
    }
    // the five kinds of business are the add-on's own and stay typed in
    expect(authored("business_type").optionList).toBeUndefined();
    expect(authored("business_type").options).toHaveLength(5);
    // the list-bound fields are the ones that had options typed in before (plus the MSIC codes, which were typed digits)
    const hadOptions = MERCHANT_FORM_V1.fields.filter((f) => f.options && f.key !== "business_type").map((f) => f.key);
    expect(Object.keys(LIST_FIELDS).sort()).toEqual([...hadOptions, "msic_codes"].sort());
  });

  it("is sound as authored: every named list exists and no field has both a list and options (listProblems, validateForm)", () => {
    for (const form of [MERCHANT_FORM_V2, SHIPPED_FORM]) {
      expect(listProblems(form, { known: new Set(SYSTEM_LIST_KEYS), authored: true })).toEqual([]);
      expect(sensitiveProblems(form)).toEqual([]);
    }
    expect(validateForm(SHIPPED_FORM, MERCHANT_ROLES, placements)).toEqual([]);
    // (generation 2 is validated against the placements it shipped with)
    expect(validateForm(MERCHANT_FORM_V2, MERCHANT_ROLES, MERCHANT_PLACEMENTS_V2)).toEqual([]);
  });

  it("keeps every value an answer to the first generation could hold, so a document made with 1.1 still reads", () => {
    const catalogue = Object.fromEntries(SYSTEM_LISTS.map((l) => [l.key, new Set(l.items.map((i) => i.value))]));
    for (const [key, list] of Object.entries(LIST_FIELDS)) {
      for (const o of old(key).options ?? []) expect(catalogue[list].has(o.value), `${key}: ${o.value} is in ${list}`).toBe(true);
    }
    // and the default country is in its list
    expect(catalogue.countries.has(authored("country").defaultValue!)).toBe(true);
  });

  it("marks the bank account and the business registration number sensitive, prints the account as its last four, and leaves the tax number open", () => {
    expect(Object.keys(SENSITIVE_FIELDS).sort()).toEqual(["bank_account", "brn"]);
    expect(authored("bank_account")).toMatchObject({ sensitive: true, printMasked: "last4" });
    expect(authored("brn")).toMatchObject({ sensitive: true });
    expect(authored("brn").printMasked).toBeUndefined();
    const flagged = SHIPPED_FORM.fields.filter((f) => f.sensitive).map((f) => f.key);
    expect(flagged.sort()).toEqual(["bank_account", "brn"]);
    // nothing sensitive fills the contact, carries a default, or is compared by a rule: the checks above would say so
    for (const f of SHIPPED_FORM.fields.filter((x) => x.sensitive)) expect([f.contactField, f.writeBack, f.defaultValue, f.locked]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("leaves generation 1 exactly as version 1.1 shipped it, so an update can recognise it", () => {
    expect(MERCHANT_FORM_V1.fields.some((f) => f.optionList !== undefined || f.sensitive !== undefined)).toBe(false);
    expect(old("state").options).toHaveLength(16);
    expect(merchantForm({ generation: 1 })).toEqual(MERCHANT_FORM_V1);
    expect(merchantForm({ generation: 2 })).toEqual(MERCHANT_FORM_V2);
    expect(merchantForm({ generation: 3 })).toEqual(MERCHANT_FORM_V3);
    expect(merchantForm({ generation: 4 })).toEqual(SHIPPED_FORM);
    expect(merchantForm()).toEqual(SHIPPED_FORM);
    // same parts, same fields, same labels, in the same order, in every generation
    expect(MERCHANT_FORM_V2.fields.map((f) => [f.key, f.type, f.part])).toEqual(MERCHANT_FORM_V1.fields.map((f) => [f.key, f.type, f.part]));
    // generation 3 has the same parts (what it changes is fields: see the next describe)
    for (const other of [MERCHANT_FORM_V2, SHIPPED_FORM]) expect(other.parts).toEqual(MERCHANT_FORM_V1.parts);
  });

  it("the acknowledgement of generation 3 no longer lists the nine old headings", () => {
    const ack = (form: typeof SHIPPED_FORM) => form.fields.find((f) => f.key === "terms_accepted")!;
    for (const lang of ["en", "ms", "zh", "ko"] as const) {
      const before = ack(MERCHANT_FORM_V2).text![lang]!;
      const after = ack(SHIPPED_FORM).text![lang]!;
      expect(before, `${lang} 2.0 lists the headings`).toContain(`- ${LEGACY_TERM_HEADINGS[0].title[lang]}`);
      expect(after, `${lang} 3.0 does not`).not.toContain(`- ${LEGACY_TERM_HEADINGS[0].title[lang]}`);
      expect(after.trim()).toBeTruthy();
    }
    expect(ack(SHIPPED_FORM)).toMatchObject({ type: "acknowledge", required: true });
  });

  it("is add-on 3.1, with 1.1, 2.0 and 3.0 kept in its history on the placements those versions shipped (the nine-box Part 5)", () => {
    expect(merchantAddon.version).toBe("3.1");
    expect(merchantAddon.history?.map((h) => h.version)).toEqual(["1.1", "2.0", "3.0"]);
    expect(merchantAddon.history?.map((h) => h.templates[0].form)).toEqual([MERCHANT_FORM_V1, MERCHANT_FORM_V2, MERCHANT_FORM_V3]);
    for (const h of (merchantAddon.history ?? []).slice(0, 2)) expect(h.templates[0].fields).toBe(MERCHANT_PLACEMENTS_V2);
    expect(merchantAddon.history?.[2].templates[0].fields).toBe(MERCHANT_PLACEMENTS_V3);
    // the frozen placements are the old Part 5 (thirteen sender boxes, none of which the new template has) and the old business details and contacts
    const old = MERCHANT_PLACEMENTS_V2.filter((p) => p.type === "static_text" && p.role === SENDER_ROLE && p.page === 2 && p.key !== "p_fw_no");
    expect(old.map((p) => p.key)).toEqual(["p_fee_fpx", "p_fee_credit", "p_fee_debit", "p_channel_note", ...LEGACY_TERM_HEADINGS.map((t) => `p_term_${t.key}`)]);
    expect(MERCHANT_PLACEMENTS_V2).toHaveLength(60);
    expect(placements.some((p) => old.some((o) => o.key === p.key))).toBe(false);
    // the last page (signing) is exactly where it was, and so are the bank part and the placements of the bank and the stamp
    for (const p of MERCHANT_PLACEMENTS_V2.filter((q) => q.page === 3 || q.key.startsWith("p_bank_") || q.key === "p_finance_contact")) expect(placements.find((n) => n.key === p.key), p.key).toEqual(p);
  });

  it("prints the bank account as its last four digits on the sealed file, and the registration number in full", async () => {
    const answers: AnswerMap = { bank_account: { text: "5123456789" }, brn: { text: "201901012345" } };
    const bound = boundValues(placements, MERCHANT_FORM, answers, "en");
    expect(bound.p_bank_account.text).toBe("**** 6789");
    expect(bound.p_brn.text).toBe("201901012345");
  });
});

// ---- Part 5 (add-on 3.0): two boxes of text ----------------------------------------------------------------------------------------

describe("Part 5 is two boxes of text the sender writes", () => {
  const KEY = placements.find((p) => p.key === "p_key_terms")!;
  const FEE = placements.find((p) => p.key === "p_commercial_terms")!;
  const page5 = placements.filter((p) => p.page === KEY.page);
  const PAGE = buildMerchantLayout().pageSize;

  /** Sentences in English and Bahasa Malaysia, as the agreed wording will read. */
  const SENTENCES = [
    "The Merchant agrees that the Partner may collect payments on its behalf and settle the net amount to the registered bank account after deducting the agreed fees and any refunds.",
    "Pihak Peniaga bersetuju bahawa Rakan Kongsi boleh mengutip bayaran bagi pihaknya dan menyelesaikan jumlah bersih ke akaun bank berdaftar selepas menolak yuran dan bayaran balik.",
    "Either party may end this agreement with sixty (60) days written notice; fees due up to the date of termination remain payable. Mana-mana pihak boleh menamatkan perjanjian dengan notis bertulis 60 hari.",
  ];
  /** `n` numbered points of exactly `len` characters each (the number included), one per line. */
  const points = (n: number, len: number, upper = false) =>
    Array.from({ length: n }, (_, i) => {
      let s = `${i + 1}. `;
      for (let k = i; s.length < len; k++) s += SENTENCES[k % SENTENCES.length] + " ";
      const cut = s.slice(0, len).trimEnd();
      return upper ? cut.toUpperCase() : cut;
    }).join("\n");
  const withText = (key: string, text: string): PlacedField[] => placements.map((p) => (p.key === key ? { ...p, text } : p));

  interface Item {
    str: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }
  /** The text items of a page of a PDF, in points from the bottom-left of the page. */
  async function printed(bytes: Uint8Array, pageIndex: number): Promise<Item[]> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
    const content = await (await doc.getPage(pageIndex + 1)).getTextContent();
    return content.items.flatMap((i) => ("str" in i && i.str.trim() !== "" ? [{ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height }] : []));
  }
  const edges = (box: PlacedField) => ({ left: box.x * PAGE.w, right: (box.x + box.w) * PAGE.w, bottom: PAGE.h - (box.y + box.h) * PAGE.h, top: PAGE.h - box.y * PAGE.h });
  /** A line of text is in the box when its glyphs (a little below the baseline up to the font size above it) are between the edges. */
  const inside = (i: Item, box: PlacedField) => {
    const e = edges(box);
    return i.x >= e.left && i.x + i.w <= e.right + 0.01 && i.y - 0.25 * i.h >= e.bottom && i.y + i.h <= e.top;
  };
  const squeeze = (s: string) => s.replace(/\s+/g, "");

  /** Stamp `text` into one of the boxes and check that ALL of it is printed, line after line, inside that box, with no warning. */
  async function printsAllOf(key: "p_key_terms" | "p_commercial_terms", text: string) {
    const box = key === "p_key_terms" ? KEY : FEE;
    const fields = withText(key, text).filter((p) => p.key === key);
    const stamped = await stampFields(committedPdf(), fields, { [key]: { text } }, { locale: "en" });
    expect(stamped.warnings).toEqual([]);
    // the lines the engine added are those the bare template page does not have, wherever they landed
    const bare = await printed(committedPdf(), box.page);
    const lines = (await printed(stamped.bytes, box.page)).filter((i) => !bare.some((b) => b.str === i.str && Math.abs(b.x - i.x) < 0.01 && Math.abs(b.y - i.y) < 0.01));
    for (const l of lines) expect(inside(l, box), `"${l.str.slice(0, 40)}..." at ${l.x.toFixed(1)}, ${l.y.toFixed(1)} is outside the box`).toBe(true);
    // all of the text came out, in order (only the white space where a line was wrapped differs)
    expect(squeeze(lines.map((l) => l.str).join(""))).toBe(squeeze(text));
    return lines;
  }

  it("has exactly two sender text boxes in Part 5, replacing the thirteen, and no data field behind them", () => {
    const boxes = page5.filter((p) => p.type === "static_text");
    expect(boxes.map((p) => p.key)).toEqual(["p_commercial_terms", "p_key_terms"]);
    for (const b of boxes) expect(b).toMatchObject({ role: SENDER_ROLE, multiline: true, fontSize: PART5.fontSize, required: false });
    for (const b of boxes) expect([b.merge, b.data]).toEqual([undefined, undefined]);
    // the only other thing on the page is the acceptance tick
    expect(page5.filter((p) => p.type !== "static_text").map((p) => p.key)).toEqual(["p_terms_accepted"]);
    expect(page5).toHaveLength(3);
    // nothing of the old thirteen is left, anywhere
    expect(placements.filter((p) => /^p_(term_|fee_|channel_note)/.test(p.key))).toEqual([]);
    expect(placements).toHaveLength(60);
    // the sender's text is the placement's own text: the form has no data field for it (the 46 fields are the business, contact, bank, document and signing answers)
    expect(MERCHANT_FORM.fields.some((f) => /(^|_)terms$/.test(f.key) && f.key !== "terms_accepted")).toBe(false);
    expect(SHIPPED_FORM.fields).toHaveLength(46);
  });

  it("keeps the bilingual part heading and the two bilingual section headings, and drops the 5.1 to 5.9 sub-headings", () => {
    const ops = buildMerchantLayout().ops.filter((o) => o.page === KEY.page);
    const texts = ops.flatMap((o) => (o.k === "text" ? [o.text] : []));
    expect(texts).toContain("Part 5   Commercial terms");
    expect(texts).toContain("Bahagian 5   Terma komersial");
    expect(texts).toContain("Platform fee / Yuran platform");
    expect(texts).toContain("Key terms / Terma utama");
    expect(texts.filter((t) => /^5\.\d/.test(t))).toEqual([]);
    // none of the old per-box captions either
    for (const old of ["FPX", "Credit card / Kad kredit", "Debit card / Kad debit", "Payment channel note / Nota saluran pembayaran"]) expect(texts).not.toContain(old);
    // and nothing else is drawn as a box: the two text boxes and the tick
    const boxes = ops.flatMap((o) => (o.k === "rect" && o.stroke === "line" ? [Math.round(o.h)] : []));
    expect(boxes).toEqual([Math.round(FEE.h * PAGE.h), Math.round(KEY.h * PAGE.h), 11]);
  });

  it("gives the fee box about a quarter of the page and the key terms the rest of it, all on one page", () => {
    expect(FEE.page).toBe(KEY.page);
    expect(FEE.h).toBeGreaterThan(0.18);
    expect(FEE.h).toBeLessThan(0.27);
    expect(KEY.h).toBeGreaterThan(0.5);
    // the key terms box sits under the fee box and ends just above the acceptance tick, so the page is full
    const accept = page5.find((p) => p.key === "p_terms_accepted")!;
    expect(KEY.y).toBeGreaterThan(FEE.y + FEE.h);
    expect(accept.y).toBeGreaterThan(KEY.y + KEY.h);
    expect((accept.y - (KEY.y + KEY.h)) * PAGE.h).toBeLessThan(8);
    // both fill the width between the margins
    expect(KEY.w).toBeCloseTo(FEE.w, 5);
    expect(KEY.w * PAGE.w).toBeCloseTo(PAGE.w - 80, 1);
    // signing starts on the next page, which is the last
    expect(buildMerchantLayout().pageCount).toBe(KEY.page + 2);
  });

  it("starts both boxes with the default points of default-terms.ts: one line per fee, and the nine old headings as points 1 to 9", () => {
    expect(FEE.text).toBe(DEFAULT_COMMERCIAL_TERMS);
    expect(KEY.text).toBe(DEFAULT_KEY_TERMS);
    expect(DEFAULT_COMMERCIAL_TERMS.split("\n")).toEqual([
      "FPX: [insert the agreed rate / masukkan kadar yang dipersetujui]",
      "Credit card / Kad kredit: [insert the agreed rate / masukkan kadar yang dipersetujui]",
      "Debit card / Kad debit: [insert the agreed rate / masukkan kadar yang dipersetujui]",
      "Payment channel note / Nota saluran pembayaran: [insert the payment channel note / masukkan nota saluran pembayaran]",
    ]);
    const lines = DEFAULT_KEY_TERMS.split("\n");
    expect(lines).toHaveLength(9);
    lines.forEach((line, i) => {
      const t = LEGACY_TERM_HEADINGS[i].title;
      expect(line).toBe(`${i + 1}. ${t.en} / ${t.ms}: [insert the agreed wording / masukkan perkataan yang dipersetujui]`);
    });
    // up to 15 points: the same function numbers however many there are
    expect(keyTermsText([...DEFAULT_KEY_POINTS, ...DEFAULT_KEY_POINTS]).split("\n")).toHaveLength(18);
    expect(KEY_TERMS_MAX_POINTS).toBe(15);
    expect(keyTermsText(Array.from({ length: 15 }, (_, i) => ({ title: { en: `T${i}`, ms: `S${i}` }, text: "x" }))).split("\n").pop()).toBe("15. T14 / S14: x");
  });

  it("prints the defaults in the boxes of the sealed file, in English and in Bahasa Malaysia", async () => {
    for (const locale of ["en", "ms"] as const) {
      const fixed = staticValues(placements.filter((p) => !p.data), { fw_no: "FW-0001" });
      const stamped = await stampFields(committedPdf(), placements, fixed, { locale });
      expect(stamped.warnings).toEqual([]);
      const lines = (await printed(stamped.bytes, KEY.page)).map((i) => i.str);
      expect(lines).toContain("1. Partner / Rakan kongsi: [insert the agreed wording / masukkan perkataan yang dipersetujui]");
      expect(lines).toContain("9. Settlement: twice weekly / Penyelesaian: dua kali seminggu: [insert the agreed wording / masukkan perkataan yang dipersetujui]");
      expect(lines).toContain("FPX: [insert the agreed rate / masukkan kadar yang dipersetujui]");
    }
  });

  // ---- the worst cases: every line of text is printed, inside its box -----------------------------------------------------------

  it("prints 15 points of about 250 characters in full inside the key terms box, in Malay and English, and in capitals", async () => {
    const lines = await printsAllOf("p_key_terms", points(15, 250));
    // 15 points of 250 characters wrap to a few lines each at 8 pt: well within the box
    expect(lines.length).toBeGreaterThanOrEqual(30);
    expect(lines.length).toBeLessThanOrEqual(45);
    // capital letters are the widest: still all printed
    await printsAllOf("p_key_terms", points(15, 250, true));
  });

  it("prints 15 points of 350 characters (more than 5,000 characters, about the most the box holds) in full", async () => {
    const text = points(15, 350);
    expect(text.length).toBeGreaterThan(5000);
    expect(text.length).toBeLessThanOrEqual(MAX_STATIC_TEXT);
    const lines = await printsAllOf("p_key_terms", text);
    // the last line of the last point is above the bottom edge of the box
    expect(Math.min(...lines.map((l) => l.y))).toBeGreaterThan(edges(KEY).bottom);
  });

  it("prints a fee box of about 1,200 characters in full", async () => {
    const text = Array.from({ length: 10 }, (_, i) => `Fee ${i + 1}: ${SENTENCES[i % 3].slice(0, 120)}`).join("\n");
    expect(text.length).toBeGreaterThan(1200);
    await printsAllOf("p_commercial_terms", text);
  });

  it("wraps long lines and honours explicit line breaks, a blank line included", async () => {
    const text = ["1. Short", "", `2. ${"long ".repeat(60).trim()}`, "3. Last"].join("\n");
    const lines = await printsAllOf("p_key_terms", text);
    const [first, second] = lines;
    expect(first.str).toBe("1. Short");
    // the blank line keeps its place: the second point is two line heights below the first
    expect(first.y - second.y).toBeCloseTo(2 * PART5.fontSize * 1.2, 1);
    // the long point wrapped onto more than one line, and the last point is on a line of its own
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.at(-1)!.str).toBe("3. Last");
  });

  // ---- what does not fit is refused, never cut ------------------------------------------------------------------------------------

  const TOO_LONG = points(15, 395); // under the 6,000 character ceiling, but more than the box holds

  it("flags text that does not fit its box when the template is saved, and the engine would have cut it", async () => {
    expect(TOO_LONG.length).toBeLessThanOrEqual(MAX_STATIC_TEXT);
    expect(await staticFitProblems(committedPdf(), withText("p_key_terms", TOO_LONG))).toEqual(["p_key_terms"]);
    expect(await staticFitProblems(committedPdf(), withText("p_commercial_terms", Array.from({ length: 30 }, (_, i) => `Fee line ${i + 1}`).join("\n")))).toEqual(["p_commercial_terms"]);
    // one line more than the box holds is enough
    const room = Math.floor((KEY.h * PAGE.h - 4) / (PART5.fontSize * 1.2));
    expect(room).toBeGreaterThanOrEqual(45);
    const exact = Array.from({ length: room }, (_, i) => `${i + 1}. point`).join("\n");
    expect(await staticFitProblems(committedPdf(), withText("p_key_terms", exact))).toEqual([]);
    expect(await staticFitProblems(committedPdf(), withText("p_key_terms", `${exact}\nextra`))).toEqual(["p_key_terms"]);
  });

  it("refuses to send text that does not fit, naming the box, and sends the defaults and a full 15 points", async () => {
    const freeze = async (fields: PlacedField[]) => freezeBase(committedPdf(), fields, { fw_no: "FW-1" }, { locale: "en" });
    const doc = (fields: PlacedField[]) => ({ fields_snapshot: fields });

    const ok = withText("p_key_terms", points(15, 350));
    expect(() => assertFixedTextFits(doc(ok), [])).not.toThrow();
    const full = await freeze(ok);
    expect(full.warnings).toEqual([]);
    expect(() => assertFixedTextFits(doc(ok), full.warnings)).not.toThrow();
    const defaults = await freeze(placements);
    expect(defaults.warnings).toEqual([]);

    const bad = withText("p_key_terms", TOO_LONG);
    const cut = await freeze(bad);
    expect(cut.warnings.map((w) => w.code)).toContain("text_truncated");
    let err: unknown;
    try {
      assertFixedTextFits(doc(bad), cut.warnings);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SignError);
    expect(err).toMatchObject({ code: "static_text_does_not_fit", status: 400, issues: [{ code: "static_text_does_not_fit", field: "p_key_terms" }] });
    expect((err as SignError).message).toContain('"Key terms" on page 3');
    expect((err as SignError).message).toContain("would be cut off");
    // the platform fee box is named too, when both are too long
    const both = withText("p_commercial_terms", Array.from({ length: 30 }, (_, i) => `Fee line ${i + 1}`).join("\n")).map((p) => (p.key === "p_key_terms" ? { ...p, text: TOO_LONG } : p));
    const bothCut = await freeze(both);
    expect(() => assertFixedTextFits(doc(both), bothCut.warnings)).toThrowError(/Platform fee.*Key terms/);
  });

  it("allows up to 6,000 characters of fixed text and no more", () => {
    const issues = (text: string) => validateFields(withText("p_key_terms", text), MERCHANT_ROLES, buildMerchantLayout().pageCount).map((i) => i.code);
    expect(MAX_STATIC_TEXT).toBe(6000);
    expect(issues("x".repeat(MAX_STATIC_TEXT))).toEqual([]);
    expect(issues("x".repeat(MAX_STATIC_TEXT + 1))).toEqual(["bad_static_text"]);
  });
});

// ---- generation 3 (add-on 3.0): the owner's decisions on the business details, the contacts and the documents ---------------------------

describe("generation 3 of the form: entity type, codes, SST, contacts and documents", () => {
  const field = (k: string): DataField => MERCHANT_FORM.fields.find((f) => f.key === k)!;
  const text = (t: string): FormValue => ({ text: t });
  const keys = (form: typeof MERCHANT_FORM) => form.fields.map((f) => f.key);
  const L4 = ["en", "ms", "zh", "ko"] as const;

  it("adds, removes and keeps exactly the fields the owner decided on, against what 2.0 shipped", () => {
    const before = new Set(keys(MERCHANT_FORM_V2));
    const after = new Set(keys(MERCHANT_FORM));
    expect([...before].filter((k) => !after.has(k)).sort()).toEqual(["brn_type", "business_activity", "contact_designation", "einv_pic_email", "einv_pic_name", "tax_percent", "tax_type"]);
    expect([...after].filter((k) => !before.has(k)).sort()).toEqual(["brn_old", "business_codes", "doc_minutes", "finance_email", "finance_name", "ops_email", "ops_name", "sst_payer", "sst_rate", "sst_tax_type"]);
    // the keys that stayed the same are the same field, unless this change is about them
    const changed = new Set(["business_type", "brn", "sst_no", "msic_codes", "contact_name", "contact_email", "contact_phone", "einvoice_email", "doc_form9", "doc_form49", "terms_accepted", "company_stamp"]);
    for (const f of SHIPPED_FORM.fields.filter((x) => before.has(x.key) && !changed.has(x.key))) {
      const was = MERCHANT_FORM_V2.fields.find((x) => x.key === f.key);
      expect(f, f.key).toEqual(was);
    }
    // every field is in a part of the form
    const parts = new Set(MERCHANT_FORM.parts.map((p) => p.key));
    expect(MERCHANT_FORM.fields.every((f) => parts.has(f.part))).toBe(true);
  });

  it("has the five entity types, without Bhd., and Club, society or co-operative in four languages", () => {
    expect(field("business_type").options?.map((o) => o.value)).toEqual(["sole_prop", "partnership", "sdn_bhd", "society_coop", "other"]);
    expect(field("business_type").options?.find((o) => o.value === "society_coop")?.label).toEqual({
      en: "Club, society or co-operative",
      ms: "Kelab, persatuan atau koperasi",
      zh: "俱乐部、社团或合作社",
      ko: "클럽, 협회 또는 협동조합",
    });
    // the earlier generations still have Bhd. (their documents and drafts are frozen with it)
    expect(MERCHANT_FORM_V2.fields.find((f) => f.key === "business_type")?.options?.map((o) => o.value)).toContain("bhd");
    // nothing in the new form, a rule included, mentions it
    expect(JSON.stringify(MERCHANT_FORM)).not.toContain('"bhd"');
    expect(field("doc_form9").visibleIf).toEqual({ op: "eq", field: "business_type", value: "sdn_bhd" });
    expect(field("doc_form49").visibleIf).toEqual(field("doc_form9").visibleIf);
  });

  it("asks a Business code (up to 5 codes of 5 digits) of a sole proprietor or a partnership, and MSIC codes of the others", () => {
    const state = (type?: string) => (type ? { business_type: text(type) } : {});
    const asked = (k: string, type?: string) => [fieldVisible(MERCHANT_FORM, field(k), state(type)), fieldRequired(MERCHANT_FORM, field(k), state(type))];
    for (const t of ["sole_prop", "partnership"]) {
      expect(asked("business_codes", t), t).toEqual([true, true]);
      expect(asked("msic_codes", t), t).toEqual([false, false]);
    }
    for (const t of ["sdn_bhd", "society_coop", "other"]) {
      expect(asked("business_codes", t), t).toEqual([false, false]);
      expect(asked("msic_codes", t), t).toEqual([true, true]);
    }
    // before the type is chosen neither is asked
    expect(asked("business_codes")).toEqual([false, false]);
    expect(asked("msic_codes")).toEqual([false, false]);
    // the shape of a business code: the rules of the MSIC codes, with 5 codes at most
    expect(field("business_codes")).toMatchObject({ type: "list", maxItems: 5, itemFormat: "digits", itemLength: 5, itemMinLength: 5 });
    expect(field("business_codes").optionList).toBeUndefined();
    const ok = (list: string[]) => checkDataAnswer(field("business_codes"), { list });
    expect(ok(["47111", "47211", "56101", "47321", "12345"])).toMatchObject({ ok: true });
    expect(ok(["47111", "47211", "56101", "47321", "12345", "99999"])).toMatchObject({ ok: false, code: "too_many_items" });
    expect(ok(["4711"])).toMatchObject({ ok: false, code: "item_too_short" });
    expect(ok(["471111"])).toMatchObject({ ok: false, code: "item_too_long" });
    expect(ok(["4711a"])).toMatchObject({ ok: false, code: "item_format_digits" });
    expect(ok(["47111", "47111"])).toMatchObject({ ok: false, code: "duplicate_item" });
    expect(field("msic_codes")).toMatchObject({ maxItems: 10, optionList: "msic" });
  });

  it("asks Do you pay SST? always, and the type of tax, the percentage (6, 8 or 10) and the registration number only for Yes", () => {
    expect(field("sst_payer")).toMatchObject({ type: "choice", required: true });
    expect(field("sst_payer").options?.map((o) => o.value)).toEqual(["yes", "no"]);
    for (const k of ["sst_tax_type", "sst_rate", "sst_no"]) expect(field(k), k).toMatchObject({ required: false, requiredIf: { op: "eq", field: "sst_payer", value: "yes" }, visibleIf: { op: "eq", field: "sst_payer", value: "yes" } });
    expect(field("sst_tax_type").options?.map((o) => [o.value, o.label.en, o.label.ms, o.label.zh, o.label.ko])).toEqual([
      ["service_tax", "Service tax", "Cukai perkhidmatan", "服务税", "서비스세"],
      ["sales_tax", "Sales tax", "Cukai jualan", "销售税", "판매세"],
    ]);
    expect(field("sst_rate").options?.map((o) => [o.value, o.label.en])).toEqual([
      ["6", "6%"],
      ["8", "8%"],
      ["10", "10%"],
    ]);
    // a rate is picked, not typed: 6, 8 or 10
    expect(checkDataAnswer(field("sst_rate"), { text: "8" })).toEqual({ ok: true, value: { text: "8" } });
    expect(checkDataAnswer(field("sst_rate"), { text: "7" })).toMatchObject({ ok: false, code: "not_an_option" });
    expect(checkDataAnswer(field("sst_rate"), { text: "8%" })).toMatchObject({ ok: false, code: "not_an_option" });
    expect(checkDataAnswer(field("sst_payer"), { text: "maybe" })).toMatchObject({ ok: false, code: "not_an_option" });
    // the old unconditional fields are gone, and the tax-types list is no longer used by this form (the shared list itself is untouched)
    expect(JSON.stringify(MERCHANT_FORM)).not.toContain("tax_types");
    expect(JSON.stringify(MERCHANT_FORM)).not.toContain("company_id_types");
  });

  it("asks the minutes of the latest meeting of a club, society or co-operative, and of no one else", () => {
    const f = field("doc_minutes");
    expect(f).toMatchObject({ type: "file", required: true, accept: ["pdf", "jpg", "png"], maxMb: 8, maxFiles: 3, minFiles: 1, visibleIf: { op: "eq", field: "business_type", value: "society_coop" } });
    for (const lang of L4) expect(f.label[lang]?.trim(), lang).toBeTruthy();
    expect(f.label.en).toBe("Latest minutes of meeting");
    expect(f.label.ms).toBe("Minit mesyuarat terkini");
    // the same file rules as the other uploads
    const form9 = field("doc_form9");
    expect([f.accept, f.maxMb, f.maxFiles, f.minFiles, f.help]).toEqual([form9.accept, form9.maxMb, form9.maxFiles, form9.minFiles, form9.help]);
    for (const t of ["sole_prop", "partnership", "sdn_bhd", "other"]) expect(fieldVisible(MERCHANT_FORM, f, { business_type: text(t) }), t).toBe(false);
    expect(fieldRequired(MERCHANT_FORM, f, { business_type: text("society_coop") })).toBe(true);
  });

  it("has no registration ID type and no business activity; the registration number stays, labelled without (BRN)", () => {
    expect(keys(MERCHANT_FORM)).not.toContain("brn_type");
    expect(keys(MERCHANT_FORM)).not.toContain("business_activity");
    expect(field("brn")).toMatchObject({ required: true, format: "digits", sensitive: true });
    expect(field("brn").label).toEqual({ en: "Business registration no.", ms: "No. pendaftaran perniagaan", zh: "商业注册号", ko: "사업자 등록번호" });
    // nothing printed asks for them either
    const texts = buildMerchantLayout().ops.flatMap((o) => (o.k === "text" ? [o.text] : []));
    expect(texts.filter((t) => /Registration ID type|Business activity|Aktiviti perniagaan|Jenis ID pendaftaran|designation|Jawatan/i.test(t) && !/Designation \/ Jawatan/.test(t))).toEqual([]);
    expect(placements.filter((p) => p.data === "brn_type" || p.data === "business_activity")).toEqual([]);
  });

  it("orders the contacts: person in charge, operations, finance, then one e-invoice and payment receipt email, all required", () => {
    const inContacts = MERCHANT_FORM.fields.filter((f) => f.part === "contacts");
    expect(inContacts.map((f) => f.key)).toEqual(["address", "city", "postcode", "state", "country", "company_phone", "contact_name", "contact_email", "contact_phone", "ops_name", "ops_email", "finance_name", "finance_email", "einvoice_email"]);
    expect(inContacts.every((f) => f.required)).toBe(true);
    // the keys of the old contact person are the person in charge's, so the contact write-back keeps working
    expect(field("contact_name")).toMatchObject({ type: "text", contactField: "name" });
    expect(field("contact_email")).toMatchObject({ type: "email", contactField: "email", writeBack: "if_empty" });
    expect(field("contact_phone")).toMatchObject({ type: "phone" });
    for (const k of ["ops_name", "ops_email", "finance_name", "finance_email", "einvoice_email"]) expect(field(k).contactField, k).toBeUndefined();
    expect(["ops_email", "finance_email", "einvoice_email"].map((k) => field(k).type)).toEqual(["email", "email", "email"]);
    expect(field("einvoice_email").label).toEqual({ en: "E-invoice and payment receipt email", ms: "E-mel e-Invois dan resit pembayaran", zh: "电子发票及付款收据邮箱", ko: "전자세금계산서 및 결제 영수증 이메일" });
    expect(field("contact_name").label.ms).toBe("Orang yang bertanggungjawab: nama");
    expect(field("ops_name").label.en).toBe("Operations responsible: name");
    expect(field("finance_email").label.ms).toBe("Orang bertanggungjawab kewangan: e-mel");
    // the e-invoice person, the contact's designation and the separate finance e-invoice email are gone
    for (const gone of ["contact_designation", "einv_pic_name", "einv_pic_email"]) expect(keys(MERCHANT_FORM)).not.toContain(gone);
    // the bank part still has its own finance contact person (unchanged)
    expect(field("finance_contact")).toMatchObject({ part: "bank", required: true });
  });

  it("prints the conditional fields: the unused code box and the SST details stay blank, and the right ticks are ticked", async () => {
    const { answers } = await withImages();
    const sole: AnswerMap = { ...answers, business_type: { text: "sole_prop" }, business_codes: { list: ["47111", "56101"] }, msic_codes: { list: ["47111"] }, sst_payer: { text: "no" }, doc_form9: undefined };
    const printedFor = (a: AnswerMap, locale: "en" | "ms" = "en") => boundValues(placements, MERCHANT_FORM, a, locale);
    const s = printedFor(sole);
    expect(s.p_business_type_is_sole_prop).toEqual({ checked: true });
    expect(s.p_business_codes.text).toBe("47111, 56101");
    expect(s.p_msic_codes).toBeUndefined();
    expect(s.p_sst_payer_is_no).toEqual({ checked: true });
    expect([s.p_sst_tax_type, s.p_sst_rate, s.p_sst_no, s.p_sst_payer_is_yes]).toEqual([undefined, undefined, undefined, undefined]);
    // a society pays SST and gives MSIC codes
    const society = printedFor({ ...answers, business_type: { text: "society_coop" }, msic_codes: { list: ["94991"] }, business_codes: { list: ["47111"] } }, "ms");
    expect(society.p_business_type_is_society_coop).toEqual({ checked: true });
    expect(society.p_msic_codes.text).toBe("94991");
    expect(society.p_business_codes).toBeUndefined();
    expect(society.p_sst_rate.text).toBe("8%");
    expect(society.p_sst_tax_type.text).toBe("Cukai perkhidmatan");
    // and the whole page still prints without a warning
    const { values } = await valuesFor("en");
    const stamped = await stampFields(committedPdf(), placements, { ...values, ...s }, { locale: "en", timeZone: "Asia/Kuala_Lumpur" });
    expect(stamped.warnings).toEqual([]);
  });

  it("prints a bilingual note under the two code boxes, and the minutes of meeting in the checklist of documents", () => {
    const ops = buildMerchantLayout().ops.flatMap((o) => (o.k === "text" ? [o] : []));
    const texts = ops.map((o) => o.text);
    expect(texts).toContain("Sole proprietor and partnership: Business code. Others: MSIC code.");
    expect(texts).toContain("Pemilik tunggal dan perkongsian: Kod perniagaan. Lain-lain: Kod MSIC.");
    // Part 4 (3.1): one line for the minutes of meeting, in both languages, with the box that prints the name of the file
    expect(texts).toContain("Latest minutes of meeting (club, society or co-operative)");
    expect(texts).toContain("Minit mesyuarat terkini (kelab, persatuan atau koperasi)");
    expect(texts).toContain("Form 9 (Sdn. Bhd.)");
    expect(texts.some((t) => /Bhd\.\s*(or|atau)\s*Bhd|\bBhd\.:/.test(t) && !/Sdn\. Bhd/.test(t))).toBe(false);
    // the two boxes sit side by side, with the note just below
    const box = (k: string) => placements.find((p) => p.key === k)!;
    expect(box("p_business_codes").page).toBe(box("p_msic_codes").page);
    expect(box("p_business_codes").y).toBeCloseTo(box("p_msic_codes").y, 5);
    const note = ops.find((o) => o.text.startsWith("Sole proprietor and partnership: Business code"))!;
    expect(note.y).toBeGreaterThan((box("p_msic_codes").y + box("p_msic_codes").h) * buildMerchantLayout().pageSize.h - 1);
    expect(note.y).toBeLessThan((box("p_msic_codes").y + box("p_msic_codes").h) * buildMerchantLayout().pageSize.h + 8);
  });

  it("draws the entity types as five tick boxes, the SST question as Yes and No, and the contact groups with their own headings", () => {
    const tick = (k: string) => placements.filter((p) => p.type === "checkbox" && p.key.startsWith(k)).map((p) => p.key.slice(k.length));
    expect(tick("p_business_type_is_")).toEqual(["sole_prop", "partnership", "sdn_bhd", "society_coop", "other"]);
    expect(tick("p_sst_payer_is_")).toEqual(["yes", "no"]);
    const texts = buildMerchantLayout().ops.flatMap((o) => (o.k === "text" ? [o.text] : []));
    for (const h of ["Person in charge / Orang yang bertanggungjawab", "Operations responsible / Orang bertanggungjawab operasi", "Finance responsible / Orang bertanggungjawab kewangan", "Do you pay SST? / Adakah anda membayar SST?"]) expect(texts).toContain(h);
    expect(texts).toContain("Club, society or co-operative / Kelab, persatuan atau koperasi");
  });
});


// ---- add-on 3.1: the old registration number, the stamp made from the company details, Part 4 with the file names -----------------------

describe("generation 4 of the form: the old registration number and the company stamp", () => {
  const field = (k: string): DataField => MERCHANT_FORM.fields.find((f) => f.key === k)!;
  const TYPES = ["sole_prop", "partnership", "sdn_bhd", "society_coop", "other"] as const;
  const withType = (t: string): AnswerMap => ({ business_type: { text: t } });

  it("adds exactly one field to 3.0, right after the registration number, and changes one: the stamp", () => {
    const keys = MERCHANT_FORM.fields.map((f) => f.key);
    const v3 = MERCHANT_FORM_V3.fields.map((f) => f.key);
    expect(keys.filter((k) => !v3.includes(k))).toEqual(["brn_old"]);
    expect(v3.filter((k) => !keys.includes(k))).toEqual([]);
    expect(keys[keys.indexOf("brn") + 1]).toBe("brn_old");
    for (const f of SHIPPED_FORM.fields.filter((x) => v3.includes(x.key) && x.key !== "company_stamp")) expect(f, f.key).toEqual(MERCHANT_FORM_V3.fields.find((x) => x.key === f.key));
    // no existing key was renamed or removed
    expect(v3.every((k) => keys.includes(k))).toBe(true);
    expect(MERCHANT_FORM_V3.fields.find((f) => f.key === "company_stamp")).not.toHaveProperty("stamp");
  });

  it("asks the old registration number, optionally, of a Sdn. Bhd., a club, society or co-operative, and Others, and not of a sole proprietor or a partnership", () => {
    const f = field("brn_old");
    expect(f).toMatchObject({ type: "text", part: "company", required: false, format: "alnum_hyphen", maxLength: 20 });
    expect(f.sensitive).toBeUndefined();
    expect(f.label).toEqual({ en: "Old registration number (if any)", ms: "No. pendaftaran lama (jika ada)", zh: "旧注册号（如有）", ko: "이전 등록번호 (있는 경우)" });
    const shown = TYPES.filter((t) => fieldVisible(MERCHANT_FORM, f, withType(t)));
    expect(shown).toEqual(["sdn_bhd", "society_coop", "other"]);
    for (const t of TYPES) expect(fieldRequired(MERCHANT_FORM, f, withType(t)), t).toBe(false);
    // never needed to finish the form, whatever the type
    for (const t of TYPES) expect(missingFormRequired(MERCHANT_FORM, MERCHANT_ROLE, withType(t)).map((x) => x.key)).not.toContain("brn_old");
  });

  it("takes letters, digits and hyphens like 123456-A, up to 20, and nothing else", () => {
    const f = field("brn_old");
    for (const ok of ["123456-A", "001234567-K", "654321-X"]) expect(checkDataAnswer(f, { text: ok }), ok).toMatchObject({ ok: true });
    for (const bad of ["123 456-A", "123456--A", "-A", "123456/A", "A_1"]) expect(checkDataAnswer(f, { text: bad }), bad).toMatchObject({ ok: false, code: "format_alnum_hyphen" });
    expect(checkDataAnswer(f, { text: "1".repeat(21) })).toMatchObject({ ok: false, code: "text_too_long" });
    expect(checkDataAnswer(f, { text: "" })).toEqual({ ok: true, value: null });
  });

  it("prints it beside the registration number, and not for a type that is not asked it", async () => {
    const box = (k: string) => placements.find((p) => p.key === k)!;
    expect(box("p_brn_old")).toMatchObject({ type: "text", data: "brn_old", role: SENDER_ROLE });
    expect(box("p_brn_old").page).toBe(box("p_brn").page);
    expect(box("p_brn_old").y).toBeCloseTo(box("p_brn").y, 5);
    expect(box("p_brn_old").x).toBeGreaterThan(box("p_brn").x);
    const answers = (await withImages()).answers;
    expect(boundValues(placements, MERCHANT_FORM, answers, "en").p_brn_old).toEqual({ text: "123456-A" });
    expect(boundValues(placements, MERCHANT_FORM, { ...answers, business_type: { text: "sole_prop" } }, "en").p_brn_old).toBeUndefined();
  });

  it("switches the stamp on for company_stamp, from the legal name, the registration number and the old number, and the form is sound", () => {
    const f = field("company_stamp");
    expect(f).toMatchObject({ type: "image", required: false, part: "signing" });
    expect(f.stamp).toEqual({ nameField: "legal_name", newNumberField: "brn", oldNumberField: "brn_old" });
    expect(validateForm(MERCHANT_FORM, MERCHANT_ROLES, placements)).toEqual([]);
    // the sources are real fields of the same role, so the signer's page has them
    for (const k of Object.values(f.stamp!)) expect(MERCHANT_FORM.fields.find((x) => x.key === k)?.part).toBe("company");
    expect(f.help?.en).toContain("create one from your company details");
    for (const lang of ["ms", "zh", "ko"] as const) expect(f.help?.[lang]?.length, lang).toBeGreaterThan(10);
  });

  it("still prints a created stamp like an uploaded one: the same upload placement, from the same answer", async () => {
    const stamp = placements.find((p) => p.data === "company_stamp")!;
    expect(stamp.type).toBe("upload");
    const png = await scribblePng();
    const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const values = boundValues(placements, MERCHANT_FORM, { ...SAMPLE, company_stamp: { image: dataUrl, mime: "image/png" } }, "en");
    expect(values[stamp.key]).toMatchObject({ image: { mime: "image/png" } });
  });
});

describe("Part 4 lists the documents of the form, with the names of the files uploaded", () => {
  const TYPES = ["sole_prop", "partnership", "sdn_bhd", "society_coop", "other"] as const;
  const docFields = MERCHANT_FORM.fields.filter((f) => f.type === "file");
  const withType = (t: string): AnswerMap => ({ business_type: { text: t } });

  it("has one line and one text box for every document field of the form, in the order the form asks them, and nothing else", () => {
    expect(DOCUMENT_ROWS.map((r) => r.key)).toEqual(docFields.map((f) => f.key));
    const boxes = placements.filter((p) => p.data && docFields.some((f) => f.key === p.data));
    expect(boxes.map((p) => p.data)).toEqual(docFields.map((f) => f.key));
    for (const b of boxes) expect(b).toMatchObject({ type: "text", role: SENDER_ROLE, multiline: true, fontSize: 7 });
    // all on one page, below the Part 4 heading
    expect(new Set(boxes.map((b) => b.page)).size).toBe(1);
  });

  it("says, for every type of business, exactly the documents the form requires and the ones it only offers", () => {
    for (const t of TYPES) {
      const answers = withType(t);
      const required = docFields.filter((f) => fieldRequired(MERCHANT_FORM, f, answers)).map((f) => f.key);
      const optional = docFields.filter((f) => fieldVisible(MERCHANT_FORM, f, answers) && !fieldRequired(MERCHANT_FORM, f, answers)).map((f) => f.key);
      expect(DOCUMENT_ROWS.filter((r) => r.required.includes(t)).map((r) => r.key), `${t}: required`).toEqual(required);
      expect(DOCUMENT_ROWS.filter((r) => r.optional?.includes(t)).map((r) => r.key), `${t}: optional`).toEqual(optional);
    }
    // the case that was missing before 3.1: a club, society or co-operative also gives a bank statement header, an ID and pictures
    expect(DOCUMENT_ROWS.find((r) => r.key === "doc_bank_statement")?.required).toContain("society_coop");
    expect(DOCUMENT_ROWS.find((r) => r.key === "doc_minutes")?.required).toEqual(["society_coop"]);
  });

  it("words every line in English and Bahasa Melayu and says for whom it is, and prints those words", () => {
    const texts = buildMerchantLayout().ops.flatMap((o) => (o.k === "text" ? [o.text] : []));
    for (const r of DOCUMENT_ROWS) {
      expect(texts, r.key).toContain(r.en);
      expect(texts, r.key).toContain(r.ms);
    }
    expect(DOCUMENT_ROWS.find((r) => r.key === "doc_registration_other")?.en).toContain("others");
    expect(DOCUMENT_ROWS.find((r) => r.key === "doc_form9")?.en).toContain("Sdn. Bhd.");
    // the old checklist wording is gone
    expect(texts).not.toContain("Uploaded with this application and kept with the signed record.");
  });

  it("gives each box room for the files its field takes, one line each", () => {
    const H = buildMerchantLayout().pageSize.h;
    for (const f of docFields) {
      const box = placements.find((p) => p.data === f.key)!;
      expect(box.h * H, f.key).toBeGreaterThanOrEqual((f.maxFiles ?? 1) * 7 * 1.2 + 3);
    }
  });

  it("prints the file names of a Sdn. Bhd. on the sealed file, long and accented ones shortened to one line, with no warning", async () => {
    const { values, bound } = await valuesFor("en");
    expect(bound.p_doc_form49).toEqual({ text: "form49-page1.pdf\nform49-page2.pdf" });
    const owner = (bound.p_doc_owner_id as { text: string }).text.split("\n");
    expect(owner).toHaveLength(4);
    expect(owner[2].endsWith("….jpg")).toBe(true);
    expect(owner[3]).toContain("kedua-é");
    expect(bound.p_doc_form_d).toBeUndefined();
    const result = await stampFields(committedPdf(), placements, values, { locale: "en", timeZone: "Asia/Kuala_Lumpur" });
    expect(result.warnings).toEqual([]);
  });

  it("never asks the signer to rename a file: the longest names fit their boxes (no text_truncated, so the answer is never too long)", async () => {
    const names = Array.from({ length: 4 }, (_, i) => `${"very-long-file-name-".repeat(15)}${i}.pdf`);
    const answers: AnswerMap = { ...SAMPLE, doc_owner_id: uploaded(...names), doc_form49: uploaded(...names.slice(0, 3)), premise_pictures: uploaded(...names.slice(0, 3)) };
    const fit = await fitProblems(committedPdf(), placements, MERCHANT_FORM, answers, "en");
    expect(fit.filter((p) => p.field.startsWith("doc_") || p.field === "premise_pictures")).toEqual([]);
  });

  it("prints nothing for a document that was not asked of this type of business", () => {
    const answers: AnswerMap = { ...SAMPLE, business_type: { text: "sole_prop" } };
    const bound = boundValues(placements, MERCHANT_FORM, answers, "en");
    // Form 9 and 49 are for a Sdn. Bhd.: hidden answers are ignored
    expect(bound.p_doc_form9).toBeUndefined();
    expect(bound.p_doc_form49).toBeUndefined();
    expect(bound.p_doc_bank_statement).toEqual({ text: "maybank-statement-header.pdf" });
  });
});
