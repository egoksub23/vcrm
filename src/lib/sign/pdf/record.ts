// ============================================================
// The submission record of a form without a signature (migration 169, F-97). When everyone has submitted there is no
// document to stamp, so the sealed file is a record: a title, who submitted and when, every answer by part in the
// document's language (a sensitive answer only as the mask the caller passes in), the files with their fingerprints and
// the fingerprint of the audit trail. The certificate pages (who, when, from where, the history, the QR code to the
// verify page) are then appended by `appendCertificate`, exactly as for a signed document, and the whole file is sealed.
//
// This module draws the answer pages only and takes plain words and values: it neither reads the database nor decides what
// to mask. It uses the same fonts, wrapping and dates as the certificate pages. Also here: the one-page file a form
// document carries as its "base" file (a form has no document to sign, but every sent document has a fingerprinted base).
// ============================================================

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

import { embedFonts, measureRuns, runsFor, type EngineFonts } from "./fonts";
import { formatDateTime, wrapText, type EngineLocale } from "./format";
import { drawIdFooter } from "./idfooter";
import { openPdf, savePdf, sha256Hex } from "./load";

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 48;
const INK = rgb(0.08, 0.09, 0.14);
const MUTED = rgb(0.4, 0.42, 0.5);
const LINE = rgb(0.85, 0.86, 0.9);
const ACCENT = rgb(0.31, 0.2, 0.86);
const KEY_W = 170;

export interface RecordLabels {
  heading: string;
  reference: string;
  workspace: string;
  submittedBy: string;
  submittedOn: string;
  language: string;
  chainHead: string;
  answers: string;
  part: string;
  notAnswered: string;
  masked: string;
  picture: string;
  filesTitle: string;
  fileSha: string;
  fileSize: string;
  sensitiveNote: string;
  page: string;
  of: string;
}

export const DEFAULT_RECORD_LABELS: RecordLabels = {
  heading: "Submission record",
  reference: "Reference",
  workspace: "Workspace",
  submittedBy: "Submitted by",
  submittedOn: "Submitted",
  language: "Language",
  chainHead: "Audit trail fingerprint",
  answers: "Answers",
  part: "Part",
  notAnswered: "Not answered",
  masked: "shown masked",
  picture: "A picture was attached",
  filesTitle: "Files submitted",
  fileSha: "SHA-256",
  fileSize: "Size",
  sensitiveNote: "Answers marked sensitive are shown masked. They are kept encrypted and are not part of this record.",
  page: "Record page",
  of: "of",
};

export interface RecordFile {
  name: string;
  size: number;
  /** 64 hex characters. */
  sha256: string;
}

export interface RecordRow {
  label: string;
  /** The answer in words. A sensitive answer arrives already masked. */
  text: string;
  answered: boolean;
  sensitive: boolean;
  picture: boolean;
  files: RecordFile[];
}

export interface RecordPart {
  title: string;
  role: string;
  rows: RecordRow[];
}

export interface RecordData {
  title: string;
  reference: string;
  workspaceName: string;
  /** Who submitted (name and role), in the order the document lists them. */
  people: { name: string; role: string }[];
  submittedAt: Date;
  timeZone?: string;
  /** The audit trail's last fingerprint when the record is made. */
  chainHead: string;
  /** The document's language, in words ("English"). */
  languageName: string;
  parts: RecordPart[];
  labels?: Partial<RecordLabels>;
}

class Pager {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];
  constructor(readonly doc: PDFDocument, readonly fonts: EngineFonts) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.pages.push(this.page);
    this.y = A4.h - MARGIN;
  }
  ensure(height: number) {
    if (this.y - height < MARGIN + 28) this.newPage();
  }
}

const width = (font: PDFFont, cjk: PDFFont | null, text: string, size: number) => measureRuns(runsFor(text, font, cjk).runs, size);

function drawLine(c: Pager, text: string, x: number, y: number, size: number, font: PDFFont, color = INK, page: PDFPage = c.page) {
  let at = x;
  for (const run of runsFor(text, font, c.fonts.cjk).runs) {
    page.drawText(run.text, { x: at, y, size, font: run.font, color });
    at += run.font.widthOfTextAtSize(run.text, size);
  }
}

/** A label on the left and its value, wrapped, on the right. */
function pair(c: Pager, key: string, value: string, opts: { size?: number; muted?: boolean; mono?: boolean } = {}) {
  const size = opts.size ?? 9;
  const lines = wrapText(value, A4.w - MARGIN * 2 - KEY_W, (s) => width(c.fonts.regular, c.fonts.cjk, s, size));
  c.ensure(Math.max(lines.length, 1) * size * 1.4 + 4);
  const top = c.y;
  drawLine(c, key, MARGIN, top - 11, 8.5, c.fonts.regular, MUTED);
  let y = top;
  for (const line of lines) {
    y -= size * 1.35;
    drawLine(c, line, MARGIN + KEY_W, y, size, c.fonts.regular, opts.muted ? MUTED : INK);
  }
  c.y = Math.min(y, top - 12) - 3;
}

function paragraph(c: Pager, text: string, size = 8, color = MUTED) {
  for (const line of wrapText(text, A4.w - MARGIN * 2, (s) => width(c.fonts.regular, c.fonts.cjk, s, size))) {
    c.ensure(size * 1.4);
    c.y -= size * 1.3;
    drawLine(c, line, MARGIN, c.y, size, c.fonts.regular, color);
  }
}

function rule(c: Pager) {
  c.ensure(10);
  c.y -= 4;
  c.page.drawLine({ start: { x: MARGIN, y: c.y }, end: { x: A4.w - MARGIN, y: c.y }, thickness: 0.6, color: LINE });
  c.y -= 6;
}

const sizeWords = (bytes: number): string => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);

/**
 * The answer pages of a submission record. The caller appends the certificate pages and seals the result.
 * Returns the file and how many pages it has (the certificate then says how many pages the record has).
 */
export async function buildSubmissionRecord(data: RecordData, options: { locale?: EngineLocale; idFooter?: string } = {}): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const fonts = await embedFonts(doc);
  const L: RecordLabels = { ...DEFAULT_RECORD_LABELS, ...(data.labels ?? {}) };
  const tz = data.timeZone ?? "UTC";
  const locale = options.locale ?? "en";
  const c = new Pager(doc, fonts);

  // heading band
  c.page.drawRectangle({ x: 0, y: A4.h - 70, width: A4.w, height: 70, color: ACCENT });
  drawLine(c, L.heading, MARGIN, A4.h - 44, 20, fonts.bold, rgb(1, 1, 1));
  drawLine(c, data.workspaceName, MARGIN, A4.h - 60, 9.5, fonts.regular, rgb(0.9, 0.88, 1));
  c.y = A4.h - 70 - 14;

  // the form's name, then who, when and the fingerprint of the trail
  for (const line of wrapText(data.title, A4.w - MARGIN * 2, (s) => width(fonts.bold, fonts.cjk, s, 14))) {
    c.ensure(20);
    c.y -= 18;
    drawLine(c, line, MARGIN, c.y, 14, fonts.bold);
  }
  c.y -= 6;
  pair(c, L.reference, data.reference);
  pair(c, L.submittedOn, formatDateTime(data.submittedAt, tz, locale));
  data.people.forEach((p, i) => pair(c, i === 0 ? L.submittedBy : "", `${p.name} (${p.role})`));
  pair(c, L.language, data.languageName);
  pair(c, L.chainHead, data.chainHead, { size: 8 });
  rule(c);

  // the answers, by part
  c.ensure(30);
  c.y -= 8;
  drawLine(c, L.answers.toUpperCase(), MARGIN, c.y - 10, 8, fonts.bold, MUTED);
  c.y -= 18;
  data.parts.forEach((part, index) => {
    c.ensure(46);
    c.y -= 12;
    drawLine(c, `${index + 1}. ${part.title}`, MARGIN, c.y, 11, fonts.bold);
    const role = `${L.part}: ${part.role}`;
    drawLine(c, role, A4.w - MARGIN - width(fonts.regular, fonts.cjk, role, 8), c.y, 8, fonts.regular, MUTED);
    c.y -= 5;
    for (const row of part.rows) {
      if (row.files.length > 0) pair(c, row.label, row.files.map((f) => f.name).join("\n"));
      else if (row.picture) pair(c, row.label, L.picture);
      else if (row.answered) pair(c, row.label, row.sensitive ? `${row.text}  (${L.masked})` : row.text);
      else pair(c, row.label, L.notAnswered, { muted: true });
    }
    rule(c);
  });

  // every file with its fingerprint
  const files = data.parts.flatMap((p) => p.rows.flatMap((r) => r.files));
  if (files.length > 0) {
    c.ensure(30);
    c.y -= 8;
    drawLine(c, L.filesTitle.toUpperCase(), MARGIN, c.y - 10, 8, fonts.bold, MUTED);
    c.y -= 18;
    for (const f of files) {
      pair(c, f.name, `${L.fileSize}: ${sizeWords(f.size)}`);
      pair(c, L.fileSha, f.sha256, { size: 7.5, muted: true });
    }
    rule(c);
  }
  if (data.parts.some((p) => p.rows.some((r) => r.sensitive))) paragraph(c, L.sensitiveNote);

  // footers, now that the page count is known
  c.pages.forEach((page, i) => {
    drawLine(c, `${data.reference}  •  ${L.page} ${i + 1} ${L.of} ${c.pages.length}`, MARGIN, 28, 7.5, fonts.regular, MUTED, page);
    page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: A4.w - MARGIN, y: 40 }, thickness: 0.5, color: LINE });
    // the ID line (idfooter.ts) on the sealed record's pages, below the page's own footer; it never stops the record being made
    if (options.idFooter) {
      try {
        drawIdFooter(page, fonts, options.idFooter);
      } catch {
        // the record is complete without it
      }
    }
  });

  return { bytes: await savePdf(doc), pageCount: c.pages.length };
}

/**
 * The one-page file a form without a signature carries as its base file. Every sent document has a base file that is
 * fingerprinted when it is sent; a form has no document to put there, so this plain page stands in. It holds no text that
 * depends on the form, only a fixed line, so the same bytes (and the same fingerprint) are made every time. Built with a
 * standard font: nothing to embed, a few hundred bytes.
 */
export async function blankFormPage(): Promise<{ bytes: Uint8Array; sha256: string; pageCount: 1 }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([A4.w, A4.h]);
  page.drawText("Form without a signature", { x: MARGIN, y: A4.h - MARGIN - 12, size: 10, font, color: MUTED });
  const bytes = await savePdf(doc);
  // read back through the engine's own opener: what is stored must be something the product accepts
  await openPdf(bytes);
  return { bytes, sha256: sha256Hex(bytes), pageCount: 1 };
}
