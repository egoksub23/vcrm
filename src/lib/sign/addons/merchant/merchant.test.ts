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
  missingFormRequired,
  roleProgress,
  staticFitProblems,
  validateForm,
  type AnswerMap,
  type DataAnswerInput,
  type DataField,
  type FormValue,
} from "../../forms";
import { A4, scribblePng } from "../../pdf/fixtures";
import { stampFields, staticValues } from "../../pdf/stamp";
import type { FieldValue } from "../../pdf/types";
import { validateFields, validateRoles } from "../../rules";
import { merchantAddon } from "../merchant";
import { DIRECTOR_ROLE, FINANCE_ROLE, MERCHANT_FORM, MERCHANT_ROLE, MERCHANT_ROLES, TERM_HEADINGS, merchantForm } from "./form";
import { MERCHANT_PLACEMENTS, buildMerchantLayout } from "./layout";
import { buildMerchantAssets, renderMerchantPdf, summarize, summarySha256 } from "./render";

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
    const form = merchantForm({ bankRole: "finance" });
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

  it("asks SST fields only when the tax type is SST", () => {
    for (const k of ["tax_percent", "sst_no"]) {
      expect(fieldVisible(MERCHANT_FORM, field(k), {})).toBe(false);
      expect(fieldVisible(MERCHANT_FORM, field(k), { tax_type: text("na") })).toBe(false);
      expect(fieldRequired(MERCHANT_FORM, field(k), { tax_type: text("sst") })).toBe(true);
    }
  });

  it("asks for the documents of the type of business", () => {
    const need = (type: string) =>
      MERCHANT_FORM.fields
        .filter((f) => f.type === "file" && fieldRequired(MERCHANT_FORM, f, { business_type: text(type) }))
        .map((f) => f.key)
        .sort();
    expect(need("sdn_bhd")).toEqual(["doc_bank_statement", "doc_form49", "doc_form9", "doc_owner_id", "premise_pictures"]);
    expect(need("bhd")).toEqual(need("sdn_bhd"));
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
    expect(ok("msic_codes", { list: ["4711"] })).toMatchObject({ ok: false, code: "item_too_short" });
    expect(ok("msic_codes", { list: ["471112"] })).toMatchObject({ ok: false, code: "item_too_long" });
    expect(ok("msic_codes", { list: ["47x11"] })).toMatchObject({ ok: false, code: "item_format_digits" });
    expect(ok("msic_codes", { list: Array.from({ length: 11 }, (_, i) => String(47000 + i)) })).toMatchObject({ ok: false, code: "too_many_items" });
    expect(ok("state", { text: "selangor" })).toMatchObject({ ok: true });
    expect(ok("state", { text: "Atlantis" })).toMatchObject({ ok: false, code: "not_an_option" });
    expect(ok("bank_account", { text: "5123 4567" })).toMatchObject({ ok: false });
    expect(ok("bank_swift", { text: "MBBEMYKL" })).toMatchObject({ ok: true });
    expect(ok("bank_swift", { text: "mbbe" })).toMatchObject({ ok: false });
    expect(ok("terms_accepted", { checked: true })).toEqual({ ok: true, value: { checked: true } });
    expect(ok("terms_accepted", { checked: false })).toEqual({ ok: true, value: null });
  });

  it("lists the 16 states and territories, Malaysia as the default country, and the nine key terms", () => {
    expect(field("state").options).toHaveLength(16);
    expect(field("country")).toMatchObject({ defaultValue: "MY" });
    expect(field("country").options?.[0].value).toBe("MY");
    expect(field("msic_codes")).toMatchObject({ maxItems: 10, itemFormat: "digits", itemLength: 5 });
    expect(TERM_HEADINGS).toHaveLength(9);
    for (const t of TERM_HEADINGS) expect(placements.some((p) => p.key === `p_term_${t.key}` && p.type === "static_text")).toBe(true);
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
        if (f.key !== "bank_name" || o.value === "other") expect(o.label.ms?.trim(), `${f.key}/${o.value}`).toBeTruthy();
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
    expect(missing).not.toContain("tax_percent");
  });
});

// ---- the real engine ---------------------------------------------------------------------------------------------------

/** A made-up company. No real merchant, person, number or bank account is used anywhere in this repository. */
const SAMPLE: Record<string, FormValue> = {
  legal_name: { text: "KEDAI RUNCIT CONTOH JAYA ENTERPRISE SDN. BHD. (FORMERLY CONTOH TRADING)" },
  trading_name: { text: "Kedai Contoh Jaya" },
  business_type: { text: "sdn_bhd" },
  brn_type: { text: "roc" },
  brn: { text: "202001000001" },
  einvoice_phase: { text: "phase_3" },
  tin: { text: "C0000000001" },
  tax_type: { text: "sst" },
  tax_percent: { text: "8" },
  sst_no: { text: "B16-0000-00000001" },
  msic_codes: { list: ["47111", "47211", "56101"] },
  business_activity: { text: "Retail of groceries and prepared food through one shop and an online store." },
  address: { text: "No. 1, Jalan Contoh 1/1, Taman Contoh Indah, Kawasan Perindustrian Contoh" },
  city: { text: "Petaling Jaya" },
  postcode: { text: "47800" },
  state: { text: "selangor" },
  country: { text: "MY" },
  company_phone: { text: "+60312345678" },
  contact_name: { text: "Contoh Binti Ahmad" },
  contact_designation: { text: "Pengurus Operasi" },
  contact_phone: { text: "+60123456789" },
  contact_email: { text: "contoh@example.test" },
  einv_pic_name: { text: "Ali Bin Contoh" },
  einv_pic_email: { text: "kewangan@example.test" },
  einvoice_email: { text: "einvoice@example.test" },
  bank_name: { text: "maybank" },
  bank_account: { text: "514000000001" },
  bank_holder: { text: "KEDAI RUNCIT CONTOH JAYA ENTERPRISE SDN. BHD." },
  bank_branch: { text: "Petaling Jaya" },
  bank_swift: { text: "MBBEMYKL" },
  finance_contact: { text: "Ali Bin Contoh" },
  terms_accepted: { checked: true },
  signer_designation: { text: "Pengarah" },
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
  // the six placements a complete application leaves empty: the four types of business that were not chosen, and the
  // two "other" boxes, which are hidden while their rule does not hold
  const EMPTY = ["p_bank_name_other", "p_business_type_is_bhd", "p_business_type_is_other", "p_business_type_is_partnership", "p_business_type_is_sole_prop", "p_business_type_other"];

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
    expect(en.p_tax_type.text).toBe("SST (Sales and Service Tax)");
    expect(ms.p_tax_type.text).toBe("SST (Cukai Jualan dan Perkhidmatan)");
    expect(ms.p_country.text).toBe("Malaysia");
    expect(en.p_brn_type.text).toBe("ROC (company registration no.)");
    expect(ms.p_brn_type.text).toBe("ROC (no. pendaftaran syarikat)");
    expect(ms.p_msic_codes.text).toBe("47111, 47211, 56101");
    expect(ms.p_business_type_is_sdn_bhd).toEqual({ checked: true });
    expect(ms.p_business_type_is_bhd).toBeUndefined();
    expect(ms.p_terms_accepted).toEqual({ checked: true });
    expect(ms.p_company_stamp?.image?.mime).toBe("image/png");
    const { values } = await valuesFor("ms");
    const stamped = await stampFields(committedPdf(), placements, values, { locale: "ms", timeZone: "Asia/Kuala_Lumpur" });
    expect(stamped.warnings).toEqual([]);
    if (process.env.MERCHANT_SAMPLE_DIR) writeFileSync(path.join(process.env.MERCHANT_SAMPLE_DIR, "sample-ms.pdf"), stamped.bytes);
  });

  it("hides what is not asked: SST fields for a non-SST merchant, the 'other' boxes", async () => {
    const { answers } = await withImages();
    const notSst: AnswerMap = { ...answers, tax_type: { text: "na" }, tax_percent: { text: "8" }, sst_no: { text: "x" } };
    const bound = boundValues(placements, MERCHANT_FORM, notSst, "en");
    expect(bound.p_tax_type.text).toBe("Not applicable");
    expect(bound.p_tax_percent).toBeUndefined();
    expect(bound.p_sst_no).toBeUndefined();
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

  it("keeps the sender's fixed text inside its box when the owner writes real wording of a normal length", async () => {
    expect(await staticFitProblems(committedPdf(), placements)).toEqual([]);
    const reworded = placements.map((p) =>
      p.key === "p_term_partner" ? { ...p, text: "The Merchant appoints the Partner to collect payments on its behalf under the agreed terms, and agrees to follow the Partner's operating rules as updated from time to time with notice." } : p.key === "p_fee_fpx" ? { ...p, text: "1.20% per transaction, minimum RM0.50" } : p,
    );
    expect(await staticFitProblems(committedPdf(), reworded)).toEqual([]);
    const tooMuch = placements.map((p) => (p.key === "p_term_partner" ? { ...p, text: "Wording. ".repeat(200) } : p));
    expect(await staticFitProblems(committedPdf(), tooMuch)).toEqual(["p_term_partner"]);
  });

  it("describes the same template in the add-on manifest", () => {
    const t = merchantAddon.templates[0];
    expect(t.name).toBe("Merchant Application");
    expect(t.fields).toBe(MERCHANT_PLACEMENTS);
    expect(t.form).toBe(MERCHANT_FORM);
    expect(t.roles).toBe(MERCHANT_ROLES);
    expect(t.defaults).toEqual({ code_required: false, sign_in_order: false, locale: "en", expiry_days: 30, reminder_days: [3, 7] });
    expect(merchantAddon.category).toMatchObject({ key: "merchant_agreements", name: "Merchant agreements" });
  });
});
