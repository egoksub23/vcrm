// ============================================================
// Merchant Application: the layout of the template file, as DATA.
//
// One description produces both things that must agree: the drawing instructions the PDF is made from
// (render.ts) and the placed fields on it (`PlacedField[]`). Every box is a rectangle this file chose, so
// each placement is exactly the rectangle that was drawn: nothing is measured from a picture and nothing can
// drift. The file is workspace-neutral (no logo, no company name) and carries no legal wording: the fees and
// the nine key terms are headings with a placeholder paragraph the sender replaces.
//
// Pure and synchronous: no fonts and no I/O. (The width of every printed label is checked against its
// column when the PDF is drawn, so a label that does not fit fails the build, not a signer.)
//
// Coordinates are points, origin top-left, on an A4 page; placements are converted to fractions of the page.
// ============================================================

import type { PlacedField } from "../../pdf/types";
import { SENDER_ROLE } from "../../rules";
// The page is drawn from the generation-1 form: its tick boxes need the options typed in, and the PDF must not change when a field moves to a shared list.
import { DIRECTOR_ROLE, MERCHANT_FORM_V1 as MERCHANT_FORM, MERCHANT_ROLE, PART, TERM_HEADINGS } from "./form";

export const PAGE = { w: 595.28, h: 841.89 } as const;
const M = 40;
const CW = PAGE.w - 2 * M;
/** Content stops here; the footer sits below. */
const BOTTOM = PAGE.h - 54;
const GAP = 10;
const LABEL_SIZE = 6.8;
const LABEL_H = 9.5;
const BOX_H = 15;
const ROW_GAP = 7;
const BLOCK_GAP = 12;

export type Tone = "ink" | "muted" | "bar" | "white" | "line" | "tint" | "panel" | "faint";

export type LayoutOp =
  | { k: "text"; page: number; x: number; y: number; text: string; size: number; bold?: boolean; tone: Tone; maxW?: number; align?: "left" | "right" }
  | { k: "rect"; page: number; x: number; y: number; w: number; h: number; stroke?: Tone; fill?: Tone; lw?: number }
  | { k: "line"; page: number; x1: number; y1: number; x2: number; y2: number; tone: Tone; lw: number };

export interface MerchantLayout {
  pageCount: number;
  pageSize: { w: number; h: number };
  ops: LayoutOp[];
  placements: PlacedField[];
}

// ---- building blocks ---------------------------------------------------------------------------------------------------

type Spec = Omit<PlacedField, "page" | "x" | "y" | "w" | "h" | "required"> & { required?: boolean };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  /** Share of the row's width. */
  w: number;
  label: string | null;
  h?: number;
  spec?: Spec;
  /** Draw a panel behind (the terms paragraphs) instead of a field box. */
  panel?: boolean;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RelOp = DistributiveOmit<LayoutOp, "page">;
interface RelPlacement {
  placement: Omit<PlacedField, "page">;
}

const fieldOf = (key: string) => {
  const f = MERCHANT_FORM.fields.find((x) => x.key === key);
  if (!f) throw new Error(`merchant layout: no data field "${key}"`);
  return f;
};
const bi = (l: { en: string; ms?: string }) => (l.ms && l.ms !== l.en ? `${l.en} / ${l.ms}` : l.en);
const partTitle = (key: string) => {
  const p = MERCHANT_FORM.parts.find((x) => x.key === key);
  if (!p) throw new Error(`merchant layout: no part "${key}"`);
  return p.title;
};
const partNo = (key: string) => MERCHANT_FORM.parts.findIndex((x) => x.key === key) + 1;

/** Where the form's own label is too long for its column on paper, a shorter one in the same two languages. */
const PRINT_LABEL: Record<string, string> = {
  contact_phone: "Contact person: phone / Orang dihubungi: telefon",
  einv_pic_email: "e-Invoice person in charge: email / E-mel pegawai e-Invois",
  finance_contact: "Finance contact person / Orang hubungan kewangan",
};

/** A cell that prints the answer to a data field. */
function data(key: string, w = 1, o: { h?: number; multiline?: boolean; label?: string | null; type?: PlacedField["type"]; decimals?: number; align?: PlacedField["align"] } = {}): Cell {
  const f = fieldOf(key);
  const multiline = o.multiline ?? false;
  return {
    w,
    label: o.label === undefined ? (PRINT_LABEL[key] ?? bi(f.label)) : o.label,
    h: o.h,
    spec: {
      key: `p_${key}`,
      type: o.type ?? "text",
      role: SENDER_ROLE,
      data: key,
      label: f.label.en,
      ...(multiline ? { multiline: true, fontSize: 9 } : {}),
      ...(o.decimals !== undefined ? { decimals: o.decimals } : {}),
      ...(o.align ? { align: o.align } : {}),
    },
  };
}

/** A block is laid out at the top of an imaginary page and moved to a real page when it is placed. */
class Block {
  ops: RelOp[] = [];
  placements: RelPlacement[] = [];
  y = 0;
  /** Start a new page here even if it would fit (the commercial terms are read as one page). */
  breakBefore = false;

  text(x: number, y: number, text: string, size: number, o: { bold?: boolean; tone?: Tone; maxW?: number; align?: "left" | "right" } = {}) {
    this.ops.push({ k: "text", x, y, text, size, tone: o.tone ?? "ink", ...(o.bold ? { bold: true } : {}), ...(o.maxW !== undefined ? { maxW: o.maxW } : {}), ...(o.align ? { align: o.align } : {}) });
  }

  rect(x: number, y: number, w: number, h: number, o: { stroke?: Tone; fill?: Tone; lw?: number }) {
    this.ops.push({ k: "rect", x, y, w, h, ...o });
  }

  line(x1: number, y1: number, x2: number, y2: number, tone: Tone, lw = 0.6) {
    this.ops.push({ k: "line", x1, y1, x2, y2, tone, lw });
  }

  place(spec: Spec, box: Box) {
    this.placements.push({ placement: { required: false, ...spec, x: box.x, y: box.y, w: box.w, h: box.h } });
  }

  /** The bar that opens a part. */
  bar(partKey: string) {
    const t = partTitle(partKey);
    const n = partNo(partKey);
    this.rect(M, this.y, CW, 17, { fill: "bar" });
    this.text(M + 8, this.y + 4.6, `Part ${n}   ${t.en}`, 9, { bold: true, tone: "white", maxW: CW / 2 - 8 });
    this.text(M + CW - 8, this.y + 5.2, `Bahagian ${n}   ${t.ms ?? ""}`, 8, { tone: "white", maxW: CW / 2 - 8, align: "right" });
    this.y += 17 + 9;
  }

  /** A row of cells with their labels above and their boxes below. */
  row(cells: Cell[], o: { h?: number } = {}) {
    const total = cells.reduce((s, c) => s + c.w, 0);
    const avail = CW - GAP * (cells.length - 1);
    let x = M;
    let tallest = 0;
    for (const c of cells) {
      const w = (avail * c.w) / total;
      const h = c.h ?? o.h ?? BOX_H;
      if (c.label) this.text(x, this.y, c.label, LABEL_SIZE, { tone: "muted", maxW: w });
      const box = { x, y: this.y + LABEL_H, w, h };
      if (c.panel) this.rect(box.x, box.y, box.w, box.h, { stroke: "line", fill: "panel", lw: 0.6 });
      else this.rect(box.x, box.y, box.w, box.h, { stroke: "line", fill: "tint", lw: 0.6 });
      if (c.spec) this.place(c.spec, box);
      tallest = Math.max(tallest, h);
      x += w + GAP;
    }
    this.y += LABEL_H + tallest + ROW_GAP;
  }

  /** A tick box with its words beside it; bound to one option of a data field. */
  tick(x: number, y: number, label: string, maxW: number, spec: Spec) {
    const side = 11;
    this.rect(x, y, side, side, { stroke: "line", fill: "tint", lw: 0.7 });
    this.place(spec, { x, y, w: side, h: side });
    this.text(x + side + 5, y + 2.6, label, 7.6, { maxW });
  }

  /** The tick boxes of a choice, in the given columns (x offset from the left margin, width of the words). */
  choiceTicks(key: string, values: { value: string; at: number; w: number }[], y: number) {
    const f = fieldOf(key);
    for (const v of values) {
      const o = f.options?.find((x) => x.value === v.value);
      if (!o) throw new Error(`merchant layout: no option "${v.value}" in "${key}"`);
      this.tick(M + v.at, y, bi(o.label), v.w, { key: `p_${key}_is_${v.value}`, type: "checkbox", role: SENDER_ROLE, data: key, dataValue: v.value, label: o.label.en });
    }
  }

  note(text: string, o: { size?: number; tone?: Tone; bold?: boolean; x?: number; maxW?: number } = {}) {
    const size = o.size ?? 7.6;
    this.text(o.x ?? M, this.y, text, size, { tone: o.tone ?? "muted", bold: o.bold, maxW: o.maxW ?? CW });
    this.y += size * 1.5;
  }

  get height() {
    return this.y;
  }
}

// ---- the parts ---------------------------------------------------------------------------------------------------------

function titleBlock(): Block {
  const b = new Block();
  b.text(M, b.y, "Merchant Application", 21, { bold: true, maxW: CW });
  b.y += 29;
  b.text(M, b.y, "Permohonan Peniaga", 11.5, { tone: "muted", maxW: CW });
  b.y += 19;
  b.line(M, b.y, M + CW, b.y, "line", 0.8);
  b.y += 10;
  b.note("Complete every part. What you enter online is printed in the boxes. Documents are uploaded with this application.", { size: 7.8 });
  b.note("Lengkapkan setiap bahagian. Apa yang anda masukkan dalam talian dicetak dalam kotak. Dokumen dimuat naik bersama permohonan ini.", { size: 7.8 });
  b.y += 4;
  return b;
}

function company(): Block {
  const b = new Block();
  b.bar(PART.company);
  b.row([data("legal_name", 1, { h: 30, multiline: true })]);
  b.row([data("trading_name")]);
  b.text(M, b.y, bi(fieldOf("business_type").label), LABEL_SIZE, { tone: "muted", maxW: CW });
  b.y += LABEL_H + 1;
  b.choiceTicks(
    "business_type",
    [
      { value: "sole_prop", at: 0, w: 150 },
      { value: "partnership", at: 190, w: 110 },
      { value: "sdn_bhd", at: 330, w: 70 },
      { value: "bhd", at: 420, w: 60 },
    ],
    b.y,
  );
  b.y += 11 + 8;
  b.choiceTicks("business_type", [{ value: "other", at: 0, w: 110 }], b.y);
  b.text(M + 190, b.y + 2.6, "Specify / Nyatakan:", 7.6, { maxW: 150, tone: "muted" });
  const otherBox = { x: M + 345, y: b.y - 2, w: CW - 345, h: BOX_H };
  b.rect(otherBox.x, otherBox.y, otherBox.w, otherBox.h, { stroke: "line", fill: "tint", lw: 0.6 });
  b.place(data("business_type_other").spec as Spec, otherBox);
  b.y += BOX_H + 6;
  b.row([data("brn_type"), data("brn")]);
  b.row([data("einvoice_phase")]);
  b.row([data("tin"), data("tax_type")]);
  b.row([data("tax_percent", 0.8, { type: "number", decimals: 2, align: "left" }), data("sst_no", 1.2)]);
  b.row([data("msic_codes")]);
  b.row([data("business_activity", 1, { h: 30, multiline: true })]);
  return b;
}

function contacts(): Block {
  const b = new Block();
  b.bar(PART.contacts);
  b.row([data("address", 1, { h: 40, multiline: true })]);
  b.row([data("city", 2), data("postcode", 1), data("state", 2)]);
  b.row([data("country"), data("company_phone")]);
  b.row([data("contact_name", 2), data("contact_designation", 1.4)]);
  b.row([data("contact_phone", 1), data("contact_email", 2)]);
  b.row([data("einv_pic_name"), data("einv_pic_email")]);
  b.row([data("einvoice_email")]);
  return b;
}

function bank(): Block {
  const b = new Block();
  b.bar(PART.bank);
  b.row([data("bank_name"), data("bank_name_other")]);
  b.row([data("bank_account"), data("bank_holder", 1.5)]);
  b.row([data("bank_branch"), data("bank_swift", 0.8), data("finance_contact")]);
  return b;
}

function documents(): Block {
  const b = new Block();
  b.bar(PART.documents);
  b.note("Uploaded with this application and kept with the signed record.", { size: 7.4 });
  b.note("Dimuat naik bersama permohonan ini dan disimpan bersama rekod bertandatangan.", { size: 7.4 });
  b.y += 3;
  const items: [string, string][] = [
    ["Sdn. Bhd. or Bhd.: Form 9, Form 49 and a bank statement header.", "Sdn. Bhd. atau Bhd.: Borang 9, Borang 49 dan pengepala penyata bank."],
    ["Sole proprietor or partnership: Form D and a bank statement header.", "Pemilik tunggal atau perkongsian: Borang D dan pengepala penyata bank."],
    ["Photocopy of the identity card of a director or the owner.", "Salinan kad pengenalan pengarah atau pemilik."],
    ["One to three pictures of the business premise.", "Satu hingga tiga gambar premis perniagaan."],
  ];
  for (const [en, ms] of items) {
    b.rect(M + 3, b.y + 3, 2.6, 2.6, { fill: "ink" });
    b.text(M + 12, b.y, en, 7.8, { tone: "ink", maxW: CW - 12 });
    b.y += 10;
    b.text(M + 12, b.y, ms, 7.2, { tone: "muted", maxW: CW - 12 });
    b.y += 12;
  }
  return b;
}

function feesBlock(): Block {
  const b = new Block();
  b.breakBefore = true;
  b.bar(PART.terms);
  b.text(M, b.y, "Platform fee / Yuran platform", 8.4, { bold: true, maxW: CW });
  b.y += 13;
  const fee = (key: string, label: string, text: string): Cell => ({
    w: 1,
    label,
    spec: { key: `p_${key}`, type: "static_text", role: SENDER_ROLE, text, label },
  });
  b.row([fee("fee_fpx", "FPX", "[Insert the agreed fee]"), fee("fee_credit", "Credit card / Kad kredit", "[Insert the agreed fee]"), fee("fee_debit", "Debit card / Kad debit", "[Insert the agreed fee]")]);
  b.row([
    {
      w: 1,
      label: "Payment channel note / Nota saluran pembayaran",
      h: 28,
      spec: { key: "p_channel_note", type: "static_text", role: SENDER_ROLE, text: "[Insert the payment channel note]", multiline: true, fontSize: 8.5, label: "Payment channel note" },
    },
  ]);
  b.text(M, b.y, "Key terms / Terma utama", 8.4, { bold: true, maxW: CW });
  b.y += 16;
  return b;
}

/** One key term: its heading and a marked paragraph for the agreed wording. */
function termBlock(i: number): Block {
  const t = TERM_HEADINGS[i];
  const b = new Block();
  b.text(M, b.y, `5.${i + 1}   ${bi(t.title)}`, 8.2, { bold: true, maxW: CW });
  b.y += 11.5;
  const box = { x: M, y: b.y, w: CW, h: 36 };
  b.rect(box.x, box.y, box.w, box.h, { stroke: "line", fill: "panel", lw: 0.6 });
  b.place({ key: `p_term_${t.key}`, type: "static_text", role: SENDER_ROLE, text: "[Insert the agreed wording]", multiline: true, fontSize: 8.5, label: t.title.en }, box);
  b.y += 36 + 4;
  return b;
}

function acceptBlock(): Block {
  const b = new Block();
  const f = fieldOf("terms_accepted");
  b.tick(M, b.y, "I have read and accept the fees and the key terms above.", CW - 20, { key: "p_terms_accepted", type: "checkbox", role: SENDER_ROLE, data: "terms_accepted", label: f.label.en });
  b.y += 12;
  b.text(M + 16, b.y, "Saya telah membaca dan menerima yuran dan terma utama di atas.", 7.2, { tone: "muted", maxW: CW - 20 });
  b.y += 12;
  return b;
}

function signing(): Block {
  const b = new Block();
  b.bar(PART.signing);
  b.row([
    { w: 250, label: "Authorised signature / Tandatangan sah", h: 70, spec: { key: "p_sign_merchant", type: "signature", role: MERCHANT_ROLE, required: true, label: "Authorised signature" } },
    data("company_stamp", 120, { type: "upload", h: 70, label: "Company stamp / Cop syarikat" }),
    { w: 125, label: "FW no. / No. FW", spec: { key: "p_fw_no", type: "static_text", role: SENDER_ROLE, merge: "fw_no", fontSize: 9, label: "FW no." } },
  ]);
  b.row([
    { w: 250, label: "Name / Nama", spec: { key: "p_name_merchant", type: "name", role: MERCHANT_ROLE, label: "Name" } },
    data("signer_designation", 130, { label: "Designation / Jawatan" }),
    { w: 115, label: "Date signed / Tarikh tandatangan", spec: { key: "p_date_merchant", type: "date_signed", role: MERCHANT_ROLE, label: "Date signed" } },
  ]);
  b.y += 4;
  b.line(M, b.y, M + CW, b.y, "line", 0.5);
  b.y += 9;
  b.text(M, b.y, "Countersignature (director) / Tandatangan balas (pengarah)", 8.4, { bold: true, maxW: CW });
  b.y += 13;
  b.row([
    { w: 250, label: "Signature / Tandatangan", h: 60, spec: { key: "p_sign_director", type: "signature", role: DIRECTOR_ROLE, required: true, label: "Director signature" } },
    { w: 145, label: "Name / Nama", spec: { key: "p_name_director", type: "name", role: DIRECTOR_ROLE, label: "Director name" } },
    { w: 100, label: "Date signed / Tarikh", spec: { key: "p_date_director", type: "date_signed", role: DIRECTOR_ROLE, label: "Director date signed" } },
  ]);
  return b;
}

// ---- composing the pages -----------------------------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;
const r5 = (n: number) => Math.round(n * 100000) / 100000;

/** Blocks that must share a page (a part's bar and what follows it). Each group goes where it fits. */
function groups(): Block[][] {
  return [
    [titleBlock(), company()],
    [contacts()],
    [bank()],
    [documents()],
    [feesBlock(), termBlock(0)],
    ...TERM_HEADINGS.slice(1).map((_, i) => [termBlock(i + 1)]),
    [acceptBlock()],
    [signing()],
  ];
}

export function buildMerchantLayout(): MerchantLayout {
  const ops: LayoutOp[] = [];
  const placements: PlacedField[] = [];
  let page = 0;
  let cursor = M;

  for (const group of groups()) {
    const height = group.reduce((s, b) => s + b.height, 0);
    if (cursor > M && (group[0].breakBefore || cursor + height > BOTTOM)) {
      page++;
      cursor = M;
    }
    for (const b of group) {
      const dy = cursor;
      for (const o of b.ops) {
        if (o.k === "line") ops.push({ ...o, page, y1: r2(o.y1 + dy), y2: r2(o.y2 + dy), x1: r2(o.x1), x2: r2(o.x2) });
        else ops.push({ ...o, page, x: r2(o.x), y: r2(o.y + dy), ...(o.k === "rect" ? { w: r2(o.w), h: r2(o.h) } : {}) } as LayoutOp);
      }
      for (const { placement: p } of b.placements) {
        placements.push({
          ...p,
          page,
          x: r5(p.x / PAGE.w),
          y: r5((p.y + dy) / PAGE.h),
          w: r5(p.w / PAGE.w),
          h: r5(p.h / PAGE.h),
        });
      }
      cursor += b.height;
    }
    cursor += BLOCK_GAP;
  }

  const pageCount = page + 1;
  // the footer of every page, now that the page count is known
  for (let p = 0; p < pageCount; p++) {
    ops.push({ k: "line", page: p, x1: M, y1: r2(PAGE.h - 40), x2: r2(M + CW), y2: r2(PAGE.h - 40), tone: "line", lw: 0.5 });
    ops.push({ k: "text", page: p, x: M, y: r2(PAGE.h - 33), text: "Merchant Application / Permohonan Peniaga", size: 7, tone: "faint", maxW: 300 });
    ops.push({ k: "text", page: p, x: r2(M + CW), y: r2(PAGE.h - 33), text: `Page ${p + 1} of ${pageCount} / Halaman ${p + 1} daripada ${pageCount}`, size: 7, tone: "faint", maxW: 220, align: "right" });
  }
  return { pageCount, pageSize: { w: PAGE.w, h: PAGE.h }, ops, placements };
}

/** The placements that go in the add-on's manifest. */
export const MERCHANT_PLACEMENTS: PlacedField[] = buildMerchantLayout().placements;
