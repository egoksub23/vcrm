// ============================================================
// The certificate pages appended to a signed document: who signed, when and from where, the file's
// fingerprint, the history of the document, and a QR code that opens the verification page. Added
// before the file is sealed, so the seal covers them too.
// ============================================================

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import QRCode from "qrcode";

import { embedFonts, measureRuns, runsFor, type EngineFonts } from "./fonts";
import { formatDateTime, wrapText, type EngineLocale } from "./format";
import { openPdf, savePdf } from "./load";
import type { CertificateData, CertificateEnvelope, CertificateLabels } from "./types";

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 48;
const INK = rgb(0.08, 0.09, 0.14);
const MUTED = rgb(0.4, 0.42, 0.5);
const LINE = rgb(0.85, 0.86, 0.9);
const ACCENT = rgb(0.31, 0.2, 0.86);
const GOOD = rgb(0.1, 0.5, 0.35);
const BAD = rgb(0.75, 0.2, 0.28);

export const DEFAULT_CERTIFICATE_LABELS: CertificateLabels = {
  heading: "Certificate of Completion",
  reference: "Reference",
  document: "Document",
  pages: "Pages",
  sentOn: "Sent",
  completedOn: "Completed",
  fingerprint: "SHA-256 of the file as sent",
  signers: "Signers",
  name: "Name",
  email: "Email",
  role: "Role",
  status: "Status",
  signedOn: "Signed",
  ip: "IP address",
  device: "Device",
  channel: "Sent by",
  history: "History",
  chainHead: "Audit trail fingerprint",
  verify: "Check this document",
  statusSigned: "Signed",
  statusDeclined: "Declined",
  statusPending: "Not signed",
  note: "The signing events above are kept in an audit trail in which each entry carries a fingerprint of the one before it. This file is sealed with a digital signature: if any page of it is changed after sealing, a PDF reader will say so.",
  page: "Certificate page",
  of: "of",
};

class Cursor {
  doc: PDFDocument;
  fonts: EngineFonts;
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  readonly pages: PDFPage[] = [];

  constructor(doc: PDFDocument, fonts: EngineFonts) {
    this.doc = doc;
    this.fonts = fonts;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.pages.push(this.page);
    this.pageNo += 1;
    this.y = A4.h - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 24) this.newPage();
  }
}

function lineWidth(font: PDFFont, cjk: PDFFont | null, text: string, size: number): number {
  return measureRuns(runsFor(text, font, cjk).runs, size);
}

function drawLine(c: Cursor, text: string, x: number, y: number, size: number, font: PDFFont, color = INK, page: PDFPage = c.page) {
  let cursor = x;
  for (const run of runsFor(text, font, c.fonts.cjk).runs) {
    page.drawText(run.text, { x: cursor, y, size, font: run.font, color });
    cursor += run.font.widthOfTextAtSize(run.text, size);
  }
}

function paragraph(c: Cursor, text: string, opts: { x?: number; width?: number; size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number }) {
  const size = opts.size ?? 9;
  const font = opts.font ?? c.fonts.regular;
  const x = opts.x ?? MARGIN;
  const width = opts.width ?? A4.w - MARGIN - x;
  const lines = wrapText(text, width, (s) => lineWidth(font, c.fonts.cjk, s, size));
  for (const line of lines) {
    c.ensure(size * 1.4);
    c.y -= size * 1.25;
    drawLine(c, line, x, c.y, size, font, opts.color ?? INK);
    c.y -= size * 0.15;
  }
  c.y -= opts.gap ?? 0;
}

function rule(c: Cursor) {
  c.ensure(8);
  c.y -= 4;
  c.page.drawLine({ start: { x: MARGIN, y: c.y }, end: { x: A4.w - MARGIN, y: c.y }, thickness: 0.6, color: LINE });
  c.y -= 6;
}

function section(c: Cursor, title: string) {
  c.ensure(30);
  c.y -= 8;
  drawLine(c, title.toUpperCase(), MARGIN, c.y - 10, 8, c.fonts.bold, MUTED);
  c.y -= 18;
}

function keyValue(c: Cursor, key: string, value: string, opts: { mono?: boolean } = {}) {
  const keyW = 150;
  const size = opts.mono ? 8 : 9;
  const lines = wrapText(value, A4.w - MARGIN * 2 - keyW, (s) => lineWidth(c.fonts.regular, c.fonts.cjk, s, size));
  c.ensure(lines.length * size * 1.4 + 4);
  const top = c.y;
  drawLine(c, key, MARGIN, top - 11, 8.5, c.fonts.regular, MUTED);
  let y = top;
  for (const line of lines) {
    y -= size * 1.35;
    drawLine(c, line, MARGIN + keyW, y, size, c.fonts.regular);
  }
  c.y = Math.min(y, top - 12) - 3;
}

/**
 * Migration 171: "Part of envelope {reference}": the documents signed together, each with its reference and the fingerprint of the file as
 * sent. Its own block, drawn between the document's fingerprints and the signers; certificates of documents on their own never reach it.
 */
function envelopeBlock(c: Cursor, e: CertificateEnvelope) {
  section(c, e.heading);
  paragraph(c, e.note, { size: 8.5, color: MUTED, gap: 4 });
  for (const d of e.documents) {
    c.ensure(52);
    c.y -= 4;
    paragraph(c, `${d.number}. ${d.title}${d.current ? `  (${e.hereLabel})` : ""}`, { size: 9.5, font: c.fonts.bold });
    keyValue(c, e.referenceLabel, d.reference);
    if (d.sha256) keyValue(c, e.sha256Label, d.sha256, { mono: true });
  }
  rule(c);
}

export interface CertificateResult {
  bytes: Uint8Array;
  /** Number of pages added. */
  pagesAdded: number;
}

/** Append the certificate pages to `input`. */
export async function appendCertificate(
  input: Uint8Array,
  data: CertificateData,
  options: { locale?: EngineLocale } = {},
): Promise<CertificateResult> {
  const doc = await openPdf(input);
  const fonts = await embedFonts(doc);
  const L: CertificateLabels = { ...DEFAULT_CERTIFICATE_LABELS, ...(data.labels ?? {}) };
  const tz = data.timeZone ?? "UTC";
  const locale = options.locale ?? "en";
  const fmt = (d: Date) => formatDateTime(d, tz, locale);
  const startPages = doc.getPageCount();

  const c = new Cursor(doc, fonts);

  // Heading band
  c.page.drawRectangle({ x: 0, y: A4.h - 70, width: A4.w, height: 70, color: ACCENT });
  drawLine(c, L.heading, MARGIN, A4.h - 44, 20, fonts.bold, rgb(1, 1, 1));
  drawLine(c, data.workspaceName, MARGIN, A4.h - 60, 9.5, fonts.regular, rgb(0.9, 0.88, 1));
  c.y = A4.h - 70 - 14;

  // QR code, top right of the first content block
  const qrPng = await QRCode.toBuffer(data.verifyUrl, { errorCorrectionLevel: "M", margin: 1, width: 240, type: "png" });
  const qr = await doc.embedPng(qrPng);
  const qrSize = 84;
  const qrTop = c.y;
  c.page.drawImage(qr, { x: A4.w - MARGIN - qrSize, y: qrTop - qrSize, width: qrSize, height: qrSize });

  const savedRight = A4.w - MARGIN;
  // Key facts (kept narrow enough to clear the QR code)
  const facts: [string, string, boolean?][] = [
    [L.reference, data.reference],
    [L.document, data.title],
    [L.pages, String(data.pageCount)],
    ...(data.sentAt ? ([[L.sentOn, fmt(data.sentAt)]] as [string, string][]) : []),
    [L.completedOn, fmt(data.completedAt)],
  ];
  for (const [k, v] of facts) {
    const keyW = 120;
    const size = 9;
    const lines = wrapText(v, savedRight - MARGIN - keyW - qrSize - 14, (s) => lineWidth(fonts.regular, fonts.cjk, s, size));
    c.ensure(lines.length * size * 1.4 + 4);
    const top = c.y;
    drawLine(c, k, MARGIN, top - 11, 8.5, fonts.regular, MUTED);
    let y = top;
    for (const line of lines) {
      y -= size * 1.35;
      drawLine(c, line, MARGIN + keyW, y, size, fonts.regular);
    }
    c.y = Math.min(y, top - 12) - 3;
  }
  // QR caption, then make sure the cursor is below the code
  drawLine(c, L.verify, A4.w - MARGIN - qrSize, qrTop - qrSize - 10, 7.5, fonts.regular, MUTED);
  c.y = Math.min(c.y, qrTop - qrSize - 18);

  keyValue(c, L.fingerprint, data.baseSha256, { mono: true });
  keyValue(c, L.chainHead, data.chainHead, { mono: true });
  keyValue(c, L.verify, data.verifyUrl);
  rule(c);

  if (data.envelope) envelopeBlock(c, data.envelope);

  // Signers
  section(c, L.signers);
  for (const s of data.signers) {
    const statusLabel = s.status === "signed" ? L.statusSigned : s.status === "declined" ? L.statusDeclined : L.statusPending;
    const color = s.status === "signed" ? GOOD : s.status === "declined" ? BAD : MUTED;
    c.ensure(58);
    const head = s.order ? `${s.order}. ${s.name}` : s.name;
    c.y -= 12;
    drawLine(c, head, MARGIN, c.y, 10, fonts.bold);
    const sw = fonts.bold.widthOfTextAtSize(statusLabel, 9);
    drawLine(c, statusLabel, A4.w - MARGIN - sw, c.y, 9, fonts.bold, color);
    c.y -= 3;
    keyValue(c, L.email, s.email);
    keyValue(c, L.role, s.role);
    if (s.signedAt) keyValue(c, L.signedOn, fmt(s.signedAt));
    if (s.channel) keyValue(c, L.channel, s.channel);
    if (s.ip) keyValue(c, L.ip, s.ip);
    if (s.device) keyValue(c, L.device, s.device);
    c.y -= 2;
    rule(c);
  }

  // History
  if (data.events.length) {
    section(c, L.history);
    for (const e of data.events) {
      const stamp = fmt(e.at);
      const textW = A4.w - MARGIN * 2 - 130;
      const lines = wrapText(e.text, textW, (s) => lineWidth(fonts.regular, fonts.cjk, s, 8.5));
      c.ensure(lines.length * 11.5 + 2);
      const top = c.y;
      drawLine(c, stamp, MARGIN, top - 10, 8, fonts.regular, MUTED);
      let y = top;
      for (const line of lines) {
        y -= 11.5;
        drawLine(c, line, MARGIN + 130, y, 8.5, fonts.regular);
      }
      c.y = y - 3;
    }
    rule(c);
  }

  paragraph(c, L.note, { size: 8, color: MUTED });

  // Footers, now that the page count is known
  c.pages.forEach((page, i) => {
    const text = `${data.reference}  •  ${L.page} ${i + 1} ${L.of} ${c.pages.length}`;
    drawLine(c, text, MARGIN, 28, 7.5, fonts.regular, MUTED, page);
    page.drawLine({ start: { x: MARGIN, y: 40 }, end: { x: A4.w - MARGIN, y: 40 }, thickness: 0.5, color: LINE });
  });

  const bytes = await savePdf(doc);
  return { bytes, pagesAdded: doc.getPageCount() - startPages };
}
