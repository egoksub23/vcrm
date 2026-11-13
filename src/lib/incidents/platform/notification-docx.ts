// Auto-generated Word-processor notification letter for a closed incident.
// Schools can download this, adjust the salutation, and send it to parents or external authorities.
// Uses the `docx` npm package (preinstalled).
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopPosition,
  TabStopType,
  TextRun,
  UnderlineType,
} from "docx";

import type { EvidenceDoc } from "./evidence-doc";

function w(text: string, opts: { bold?: boolean; underline?: boolean; size?: number; color?: string } = {}): TextRun {
  return new TextRun({
    text,
    bold: opts.bold,
    underline: opts.underline ? { type: UnderlineType.SINGLE } : undefined,
    size: opts.size ?? 22,
    color: opts.color,
  });
}

function para(children: TextRun[], opts: { spacing?: number; alignment?: (typeof AlignmentType)[keyof typeof AlignmentType]; indent?: number } = {}): Paragraph {
  return new Paragraph({
    children,
    spacing: { after: opts.spacing ?? 120 },
    alignment: opts.alignment,
    indent: opts.indent != null ? { left: opts.indent } : undefined,
  });
}

function blank(spacing = 120): Paragraph {
  return new Paragraph({ children: [], spacing: { after: spacing } });
}

function hr(): Paragraph {
  return new Paragraph({
    children: [],
    border: { bottom: { color: "AAAAAA", size: 6, space: 2, style: "single" } },
    spacing: { after: 120 },
  });
}

function kv(label: string, value: string | null | undefined): Paragraph {
  if (!value) return blank(0);
  return new Paragraph({
    children: [w(label + ": ", { bold: true }), w(value)],
    spacing: { after: 60 },
    tabStops: [{ type: TabStopType.LEFT, position: TabStopPosition.MAX }],
  });
}

function words(key: string | null | undefined): string {
  if (!key) return "";
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface NotificationDocxInput {
  doc: EvidenceDoc;
  schoolName: string;
  timeZone?: string;
  /** Short description suitable for external recipients — public-safe, no medical detail. */
  externalNote?: string | null;
}

function fmt(iso: string | null | undefined, tz: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return "—";
  }
}

function validZone(tz?: string): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export async function buildNotificationDocx(input: NotificationDocxInput): Promise<Uint8Array> {
  const { doc, schoolName } = input;
  const tz = validZone(input.timeZone);
  const i = doc.incident;
  const raisedOn = fmt(i.created_at, tz);
  const closedOn = i.closed_at ? fmt(i.closed_at, tz) : null;
  const today = fmt(new Date().toISOString(), tz);

  const doneSteps = doc.required_steps.filter((s) => s.status === "done");
  const involved = doc.people_named;

  const sections: Paragraph[] = [
    // Letterhead
    para([w(schoolName, { bold: true, size: 28 })], { spacing: 60 }),
    hr(),
    blank(60),

    // Date and reference
    para([w(today)], { alignment: AlignmentType.RIGHT }),
    blank(60),

    // Subject line
    para([w("INCIDENT NOTIFICATION", { bold: true, size: 24, underline: true })]),
    para([w(`Reference: ${doc.reference}`, { bold: true })]),
    blank(60),

    // Opening
    para([w("Dear Parent or Guardian,")], { spacing: 200 }),

    para([
      w("We are writing to inform you of an incident at our school that occurred on "),
      w(raisedOn, { bold: true }),
      w(". This letter serves as our formal notification in accordance with our duty of care obligations."),
    ]),
  ];

  // Incident details box
  sections.push(
    blank(60),
    new Paragraph({
      children: [w("INCIDENT DETAILS", { bold: true, size: 20, color: "444444" })],
      heading: HeadingLevel.HEADING_3,
      spacing: { after: 80 },
    }),
    kv("Reference", doc.reference),
    kv("Category", i.category_name),
    kv("Severity", i.severity_label),
    kv("Status", words(i.status)),
    kv("Date reported", raisedOn),
    ...(closedOn ? [kv("Date closed", closedOn)] : []),
    blank(60),
  );

  // Description
  if ((i.description ?? "").trim()) {
    sections.push(
      new Paragraph({ children: [w("Description", { bold: true })], spacing: { after: 80 } }),
      para([w((i.description ?? "").trim())], { spacing: 200 }),
    );
  }

  // External note (optional override text)
  if (input.externalNote?.trim()) {
    sections.push(
      new Paragraph({ children: [w("Additional notes", { bold: true })], spacing: { after: 80 } }),
      para([w(input.externalNote.trim())], { spacing: 200 }),
    );
  }

  // Students involved (by name only — no medical detail)
  if (involved.length > 0) {
    sections.push(
      new Paragraph({ children: [w("Students involved", { bold: true })], spacing: { after: 80 } }),
      ...involved.map((p) =>
        new Paragraph({
          children: [
            w(`• ${p.name}`, { bold: false }),
            ...(p.class_name ? [w(`, ${p.class_name}`)] : []),
          ],
          indent: { left: 360 },
          spacing: { after: 60 },
        }),
      ),
      blank(80),
    );
  }

  // Actions taken
  if (doneSteps.length > 0) {
    sections.push(
      new Paragraph({ children: [w("Actions taken", { bold: true })], spacing: { after: 80 } }),
      ...doneSteps.map((s) =>
        new Paragraph({
          children: [w(`• ${s.title}`, { bold: false })],
          indent: { left: 360 },
          spacing: { after: 60 },
        }),
      ),
      blank(80),
    );
  }

  // Closing paragraph
  sections.push(
    para([
      w("We take all incidents seriously and have followed our standard incident management procedures. If you have any questions or concerns, please do not hesitate to contact the school administration."),
    ], { spacing: 200 }),

    para([w("Yours sincerely,")], { spacing: 200 }),

    // Sign-off block
    blank(600),
    para([w("_____________________________   _____________________________")]),
    para([w("Name and position                    Date")], { spacing: 60, indent: 0 }),
    blank(400),

    para([w("_____________________________   _____________________________")]),
    para([w("Principal / Head of School           Date")], { spacing: 60 }),
    blank(80),

    // Footer note
    hr(),
    para(
      [w(`This document was generated from the Halo incident management system. Reference ${doc.reference}. Issued ${today}.`, { size: 18, color: "888888" })],
      { alignment: AlignmentType.CENTER, spacing: 0 },
    ),
  );

  const document = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children: sections,
      },
    ],
  });

  return new Uint8Array(await Packer.toBuffer(document));
}
