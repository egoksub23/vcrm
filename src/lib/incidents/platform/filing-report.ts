// The incident report for filing: one PDF of everything the workflow recorded for a closed incident, from the report to the closure. Built from the
// evidence document (evidence-doc.ts), so it says exactly what the incident record says. Pure apart from reading the bundled fonts: bytes in, bytes out.
//
// Text is drawn with Noto Sans (the Doc Sign engine's fonts), which covers Latin, Malay and Vietnamese. Chinese and Korean names need the optional server
// font named by SIGN_CJK_FONT_PATH; without it such a character is drawn as "?" and the result says how many, so the person generating the report is told.

import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";

import { embedFonts, measureRuns, runsFor } from "@/lib/sign/pdf/fonts";
import type { EvidenceDoc } from "./evidence-doc";
import { conclusionsOf, kindOf } from "./note-kinds";

export interface FilingImage {
  filename: string;
  bytes: Uint8Array;
  kind: "jpg" | "png";
  addedAt: string;
}

export interface FilingInput {
  doc: EvidenceDoc;
  schoolName: string;
  /** Who generated it (shown on the last page), the version of this report for the incident, and the time zone every time is shown in. */
  generatedBy: string | null;
  version: number;
  timeZone: string;
  images: readonly FilingImage[];
  /** Pictures that could not be drawn (a format the PDF cannot hold, or too large): listed by name instead. */
  imagesNotShown: readonly string[];
  /** Optional AI-drafted or manually written narrative that appears before the sign-off block. */
  narrative?: string | null;
}

export interface FilingResult {
  bytes: Uint8Array;
  pages: number;
  /** Characters the fonts could not draw (drawn as "?"). */
  unsupportedCharacters: number;
}

const A4 = { w: 595.28, h: 841.89 };
const M = { x: 50, top: 56, bottom: 52 };
const INK = rgb(0.1, 0.11, 0.13);
const MUTED = rgb(0.4, 0.42, 0.46);
const RULE = rgb(0.82, 0.84, 0.87);
const ACCENT = rgb(0.2, 0.25, 0.55);

const EVENT_WORDS: Record<string, string> = {
  created: "Incident reported",
  status_changed: "Status changed",
  severity_changed: "Severity changed",
  type_changed: "Category changed",
  lead_changed: "Incident lead changed",
  escalated: "Escalated",
  closed: "Incident closed",
  root_cause_changed: "Root cause recorded",
  title_changed: "Title changed",
  description_changed: "Description changed",
  voided: "Incident voided",
  restored: "Incident restored",
};
/** What a note is called in the report, by its kind. */
const NOTE_LABEL: Record<string, string> = { none: "Note", investigation: "Investigation note", finding: "Finding", closing: "Closing note" };
const STATUS_WORDS: Record<string, string> = { reported: "Reported", triaged: "Triaged", contained: "Contained", investigating: "Investigating", recovered: "Recovered", closed: "Closed" };
const STEP_WORDS: Record<string, string> = { open: "Open", done: "Done", skipped: "Skipped", not_applicable: "Not applicable" };

/** "head_of_sport" → "Head of sport" (the role's own label is on screen; a filed report only needs it readable). */
function words(key: string | null | undefined): string {
  if (!key) return "";
  const s = key.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function validZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function formatWhen(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: validZone(timeZone), day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

type Run = { text: string; font: PDFFont };

class Writer {
  pdf: PDFDocument;
  page!: PDFPage;
  y = 0;
  unsupported = 0;
  constructor(
    pdf: PDFDocument,
    private f: { regular: PDFFont; bold: PDFFont; cjk: PDFFont | null },
  ) {
    this.pdf = pdf;
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage([A4.w, A4.h]);
    this.y = A4.h - M.top;
  }

  ensure(h: number) {
    if (this.y - h < M.bottom) this.newPage();
  }

  /** The runs for `text` (a character no font has becomes "?"). Not counted: measuring calls this many times. */
  private runs(text: string, bold: boolean): Run[] {
    return runsFor(text, bold ? this.f.bold : this.f.regular, this.f.cjk).runs;
  }

  /** Break text into lines that fit `width`. A word wider than a line is cut where it fits. */
  private lines(text: string, size: number, width: number, bold: boolean): Run[][] {
    const out: Run[][] = [];
    const wide = (s: string) => measureRuns(this.runs(s, bold), size);
    const space = this.runs(" ", bold);
    const spaceW = measureRuns(space, size);
    for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
      let line: Run[] = [];
      let used = 0;
      const add = (rs: Run[], rw: number) => {
        for (const r of rs) {
          const last = line[line.length - 1];
          if (last && last.font === r.font) last.text += r.text;
          else line.push({ ...r });
        }
        used += rw;
      };
      for (const token of para.split(/\s+/).filter(Boolean)) {
        const pieces: string[] = [];
        if (wide(token) <= width) pieces.push(token);
        else {
          let chunk = "";
          for (const ch of Array.from(token)) {
            if (chunk && wide(chunk + ch) > width) {
              pieces.push(chunk);
              chunk = "";
            }
            chunk += ch;
          }
          if (chunk) pieces.push(chunk);
        }
        pieces.forEach((piece, k) => {
          const rs = this.runs(piece, bold);
          const rw = measureRuns(rs, size);
          const gap = used > 0 && k === 0 ? spaceW : 0;
          if (used > 0 && used + gap + rw > width) {
            out.push(line);
            line = [];
            used = 0;
          } else if (gap) add(space, spaceW);
          add(rs, rw);
        });
      }
      out.push(line);
    }
    return out;
  }

  private drawRuns(runs: Run[], x: number, y: number, size: number, color = INK) {
    let cx = x;
    for (const r of runs) {
      this.page.drawText(r.text, { x: cx, y, size, font: r.font, color });
      cx += r.font.widthOfTextAtSize(r.text, size);
    }
  }

  /** A block of text at `x` (default the left margin), wrapped to `width`. */
  text(text: string, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}) {
    const size = o.size ?? 9.5;
    const x = o.x ?? M.x;
    const width = o.width ?? A4.w - M.x - x;
    const lead = size * 1.4;
    this.unsupported += runsFor(text, o.bold ? this.f.bold : this.f.regular, this.f.cjk).unsupported;
    for (const line of this.lines(text, size, width, !!o.bold)) {
      this.ensure(lead);
      this.y -= lead;
      this.drawRuns(line, x, this.y, size, o.color ?? INK);
    }
    this.y -= o.gap ?? 0;
  }

  heading(title: string) {
    this.ensure(46);
    this.y -= 12;
    this.text(title.toUpperCase(), { size: 8.5, bold: true, color: ACCENT, gap: 2 });
    this.page.drawLine({ start: { x: M.x, y: this.y - 2 }, end: { x: A4.w - M.x, y: this.y - 2 }, thickness: 0.6, color: RULE });
    this.y -= 4;
  }

  /** Label on the left, value wrapped on the right. */
  kv(label: string, value: string | null | undefined) {
    if (!value) return;
    const lw = 108;
    const lines = this.lines(value, 9.5, A4.w - M.x * 2 - lw, false);
    this.ensure(13.3 * Math.min(lines.length, 2));
    const top = this.y;
    this.text(label, { size: 9, color: MUTED, width: lw - 6 });
    const after = this.y;
    const pagesNow = this.pdf.getPageCount();
    this.y = top;
    this.text(value, { x: M.x + lw, width: A4.w - M.x * 2 - lw });
    if (this.pdf.getPageCount() === pagesNow) this.y = Math.min(this.y, after);
  }

  /** A line with a small bullet and a hanging indent. */
  bullet(text: string, o: { sub?: string } = {}) {
    const lead = 13.3;
    this.ensure(lead);
    const top = this.y;
    this.page.drawCircle({ x: M.x + 4, y: top - lead + 3.4, size: 1.3, color: MUTED });
    this.text(text, { x: M.x + 14 });
    if (o.sub) this.text(o.sub, { x: M.x + 14, size: 8.5, color: MUTED });
  }

  space(h: number) {
    this.y -= h;
  }

  box(h: number) {
    this.ensure(h);
  }

  /** The widest an image can be drawn, and its position, are the caller's; this only draws and returns. */
  image(img: PDFImage, x: number, top: number, w: number, h: number) {
    this.page.drawImage(img, { x, y: top - h, width: w, height: h });
  }
}

export async function buildFilingPdf(input: FilingInput): Promise<FilingResult> {
  const { doc } = input;
  const tz = validZone(input.timeZone);
  const when = (iso: string | null | undefined) => formatWhen(iso, tz);
  const i = doc.incident;

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${doc.reference} incident report`);
  pdf.setProducer("Halo");
  pdf.setCreator("Halo Incident Management");
  const fonts = await embedFonts(pdf);
  const w = new Writer(pdf, fonts);
  const notShown = [...input.imagesNotShown];

  // Title block
  w.text(input.schoolName, { size: 9, color: MUTED });
  w.text("Incident report for filing", { size: 19, bold: true, gap: 2 });
  w.text(`${doc.reference}: ${i.title}`, { size: 12, bold: true, gap: 2 });
  w.text(`Closed ${when(i.closed_at)}. Report version ${input.version}, generated ${when(doc.generated_at)}${input.generatedBy ? ` by ${input.generatedBy}` : ""}. All times are ${tz}.`, { size: 8.5, color: MUTED });
  w.space(4);

  w.heading("Summary");
  w.kv("Reference", doc.reference);
  w.kv("Category", doc.incident.category_name);
  w.kv("Severity", doc.incident.severity_label);
  w.kv("Status", STATUS_WORDS[i.status] ?? words(i.status));
  w.kv("Reported", when(i.created_at));
  w.kv("Closed", when(i.closed_at));
  w.kv("Reported by", i.reporter_name ? `${i.reporter_name}${i.source === "coach_portal" ? " (through the coach portal)" : ""}${i.reporter_email ? `, ${i.reporter_email}` : ""}` : null);
  w.kv("Activity", i.activity?.name ? [i.activity.name, i.activity.venue, i.activity.date, i.activity.time].filter(Boolean).join(", ") : null);
  w.kv("Involves", (i.incident_flags ?? []).length > 0 ? (i.incident_flags ?? []).map(words).join(", ") : null);

  // How it ended, first: the closing note, the root cause and the findings, then the account of what happened.
  const conclusions = conclusionsOf(doc.comments);
  if (conclusions.closing.length > 0 || (i.root_cause ?? "").trim() || conclusions.findings.length > 0) {
    w.heading("Conclusions");
    for (const c of conclusions.closing) w.kv("Closing note", c.body);
    w.kv("Root cause", i.root_cause);
    for (const f of conclusions.findings) w.bullet(`Finding: ${f.body}`);
  }

  w.heading("What happened");
  w.text(i.description?.trim() || "No description was recorded.");

  if (doc.report_answers && doc.report_answers.length > 0) {
    w.heading("Answers on the coach's report form");
    for (const a of doc.report_answers) w.kv(a.label, a.value);
  }

  if (doc.people_named.length > 0) {
    w.heading(`People involved (${doc.people_named.length})`);
    for (const p of doc.people_named) w.bullet(`${p.name}${p.class_name ? `, ${p.class_name}` : ""} (${words(p.involvement)})${p.external_student_id ? `, ID ${p.external_student_id}` : ""}`);
  }

  if (doc.return_to_play && doc.return_to_play.length > 0) {
    w.heading("Return to play (confidential)");
    for (const c of doc.return_to_play) w.bullet(`${c.student_name}: ${words(c.type)}, not before ${c.not_before}${c.cleared_at ? " (cleared early)" : ""}${c.note ? `. ${c.note}` : ""}`);
  }

  // The story, in order: what the system recorded and what people wrote.
  const story = [
    ...doc.timeline.map((e) => {
      let text = EVENT_WORDS[e.event_type] ?? words(e.event_type);
      if (e.event_type === "status_changed" && e.to_value) text = `Status changed${e.from_value ? ` from ${STATUS_WORDS[e.from_value] ?? words(e.from_value)}` : ""} to ${STATUS_WORDS[e.to_value] ?? words(e.to_value)}`;
      else if (e.event_type === "severity_changed" && e.to_value) text = `Severity changed${e.from_value ? ` from ${labelOfSeverity(doc, e.from_value)}` : ""} to ${labelOfSeverity(doc, e.to_value)}`;
      else if (e.event_type === "title_changed") text = `Title changed from "${e.from_value ?? ""}" to "${e.to_value ?? ""}"`;
      if (e.reason && (e.event_type === "title_changed" || e.event_type === "description_changed")) text += ` (reason: ${e.reason})`;
      return { at: e.created_at, who: e.actor, text, note: false, label: "" };
    }),
    ...doc.comments.map((c) => ({ at: c.created_at, who: c.author, text: c.edited_at ? `${c.body} (edited ${when(c.edited_at)})` : c.body, note: true, label: NOTE_LABEL[kindOf(c) ?? "none"] })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  w.heading("What was done, in order");
  if (story.length === 0) w.text("Nothing else was recorded.");
  for (const e of story) {
    w.bullet(`${when(e.at)}${e.who ? `, ${e.who}` : ""}: ${e.note ? `${e.label}: ${e.text}` : e.text}`);
  }

  if (doc.required_steps.length > 0) {
    w.heading("Required steps");
    for (const s of doc.required_steps) {
      const who = s.role_key ? words(s.role_key) : words(s.party);
      const outcome = s.status === "done" ? `Done ${when(s.completed_at)}` : STEP_WORDS[s.status] ?? words(s.status);
      w.bullet(`${s.title}${who ? ` (${who})` : ""}`, { sub: `${s.due_at ? `Due ${when(s.due_at)}. ` : ""}${outcome}` });
    }
  }

  if (doc.approvals.length > 0) {
    w.heading("Approvals");
    for (const a of doc.approvals) w.bullet(`${words(a.role_key)}: ${a.decision ? words(a.decision) : "Waiting"} (${when(a.decided_at ?? a.requested_at)})${a.note ? `. ${a.note}` : ""}`);
  }

  const sent = doc.message_log.filter((m) => !m.is_test);
  if (sent.length > 0) {
    w.heading("Notices sent");
    for (const m of sent) w.bullet(`${words(m.role_key)}: ${m.recipient_name} (${m.address}) by ${m.channel}`, { sub: `${m.reason ? `${m.reason}. ` : ""}${m.sent_at ? `${words(m.status)} ${when(m.sent_at)}` : words(m.status)}${m.acknowledged_at ? `, acknowledged ${when(m.acknowledged_at)}` : ""}` });
  }

  // Pictures, two to a row.
  if (input.images.length > 0) {
    w.box(280);
    w.heading(`Pictures (${input.images.length})`);
    const colW = (A4.w - M.x * 2 - 16) / 2;
    const maxH = 190;
    let col = 0;
    let rowTop = 0;
    let rowBottom = 0;
    for (const im of input.images) {
      let img: PDFImage;
      try {
        img = im.kind === "png" ? await pdf.embedPng(im.bytes) : await pdf.embedJpg(im.bytes);
      } catch {
        notShown.push(im.filename);
        continue;
      }
      const scale = Math.min(colW / img.width, maxH / img.height, 1);
      const dw = img.width * scale;
      const dh = img.height * scale;
      if (col === 0) {
        w.box(maxH + 30);
        rowTop = w.y - 4;
        rowBottom = rowTop;
      }
      const x = M.x + col * (colW + 16);
      w.image(img, x, rowTop, dw, dh);
      // caption under the picture, inside its column
      const savedY = w.y;
      w.y = rowTop - dh - 2;
      w.text(`${im.filename}, added ${when(im.addedAt)}`, { size: 7.5, color: MUTED, x, width: colW });
      rowBottom = Math.min(rowBottom, w.y);
      // a taller caption or picture lowers the row's bottom
      w.y = savedY;
      col += 1;
      if (col === 2) {
        w.y = rowBottom - 8;
        col = 0;
      }
    }
    if (col === 1) w.y = rowBottom - 8;
  }

  if (doc.files.length > 0) {
    w.heading(`Files kept with the incident (${doc.files.length})`);
    for (const f of doc.files) w.bullet(`${f.filename} (${Math.max(1, Math.round(f.size_bytes / 1024))} KB), added ${when(f.created_at)}`, { sub: f.file_hash ? `SHA-256 ${f.file_hash}` : undefined });
    if (notShown.length > 0) w.text(`Not drawn above (the format cannot be shown here): ${notShown.join(", ")}.`, { size: 8.5, color: MUTED });
  }

  if (input.narrative?.trim()) {
    w.heading("Filing narrative");
    w.text(input.narrative.trim());
  }

  w.heading("Sign-off");
  w.box(110);
  w.space(8);
  w.text("Prepared by: ______________________________   Date: ________________", { gap: 14 });
  w.text("Reviewed by: ______________________________   Date: ________________", { gap: 14 });
  w.text("Filed under / reference: ______________________________", {});

  // Footer on every page, drawn last so it can say "of n" and warn about characters that could not be drawn.
  const pages = pdf.getPages();
  const foot = `${doc.reference}, report version ${input.version}. Contains personal information about students: keep it confidential.${w.unsupported > 0 ? ` ${w.unsupported} character(s) could not be shown and appear as ?.` : ""}`;
  const footRuns = runsFor(foot, fonts.regular, fonts.cjk).runs;
  pages.forEach((p, n) => {
    p.drawLine({ start: { x: M.x, y: 40 }, end: { x: A4.w - M.x, y: 40 }, thickness: 0.5, color: RULE });
    let cx = M.x;
    for (const r of footRuns) {
      p.drawText(r.text, { x: cx, y: 28, size: 7, font: r.font, color: MUTED });
      cx += r.font.widthOfTextAtSize(r.text, 7);
    }
    const label = `Page ${n + 1} of ${pages.length}`;
    p.drawText(label, { x: A4.w - M.x - fonts.regular.widthOfTextAtSize(label, 7), y: 28, size: 7, font: fonts.regular, color: MUTED });
  });

  const bytes = await pdf.save();
  return { bytes, pages: pages.length, unsupportedCharacters: w.unsupported };
}

function labelOfSeverity(doc: EvidenceDoc, slug: string): string {
  return doc.names?.severities.find((s) => s.slug === slug)?.label ?? words(slug);
}
