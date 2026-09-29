// ============================================================
// Shared docx-building helpers for the four incident notification
// documents (Form A/B/C/D). Not pixel-identical to the original Word
// templates — structurally and informationally equivalent, organized
// in the same section order, generated with the `docx` npm package
// (page size defaults to A4, matching the source templates).
//
// docx has no native checkbox support — Form A/C/D's ☐ checkboxes are
// rendered as plain ☒/☐ Unicode glyphs in a text run, same convention
// used throughout this codebase's other generated documents.
// ============================================================
import {
  AlignmentType,
  BorderStyle,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IStylesOptions,
} from "docx";

/** A4 content width (twips) at the default 1" margins: 11906 - 2×1440. */
export const CONTENT_WIDTH_DXA = 9026;

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const HAIR_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };

export function cellBorders() {
  return { top: HAIR_BORDER, bottom: HAIR_BORDER, left: HAIR_BORDER, right: HAIR_BORDER };
}

export function docTitle(name: string, letter: "A" | "B" | "C" | "D", subtitle: string): Table {
  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH_DXA - 1600, 1600],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: CONTENT_WIDTH_DXA - 1600, type: WidthType.DXA },
            borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
            children: [
              new Paragraph({ children: [new TextRun({ text: "Debit Circles Sdn. Bhd. (Vircle)", bold: true })] }),
              new Paragraph({ children: [new TextRun({ text: name, bold: true, size: 28 })] }),
              new Paragraph({ children: [new TextRun({ text: subtitle, size: 18, color: "555555" })] }),
            ],
          }),
          new TableCell({
            width: { size: 1600, type: WidthType.DXA },
            borders: { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER },
            verticalAlign: "center",
            children: [
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "FORM", bold: true, size: 16 })] }),
              new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: letter, bold: true, size: 32 })] }),
            ],
          }),
        ],
      }),
    ],
  });
}

export function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 240, after: 80 },
    children: [new TextRun({ text, bold: true, size: 22 })],
  });
}

/** A label/value reference-block table — two columns, label cells shaded. */
export function referenceTable(rows: [string, string][]): Table {
  const labelWidth = 2800;
  const valueWidth = CONTENT_WIDTH_DXA - labelWidth;
  return new Table({
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    columnWidths: [labelWidth, valueWidth],
    rows: rows.map(
      ([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              width: { size: labelWidth, type: WidthType.DXA },
              borders: cellBorders(),
              shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
              children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 18 })] })],
            }),
            new TableCell({
              width: { size: valueWidth, type: WidthType.DXA },
              borders: cellBorders(),
              children: [new Paragraph({ children: [new TextRun({ text: value || "—", size: 18 })] })],
            }),
          ],
        }),
    ),
  });
}

/** A single body paragraph under a heading — free text, wraps `—` for empty. */
export function bodyText(text: string | null | undefined, size = 18): Paragraph {
  return new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: text?.trim() || "—", size })] });
}

/** "☒ Option A   ☐ Option B   ☐ Option C" — one line, unavailable options never shown as ☒. */
export function checkboxLine(options: { label: string; checked: boolean }[]): Paragraph {
  const runs: TextRun[] = [];
  options.forEach((o, i) => {
    if (i > 0) runs.push(new TextRun({ text: "   " }));
    runs.push(new TextRun({ text: (o.checked ? "☒ " : "☐ ") + o.label, size: 18 }));
  });
  return new Paragraph({ spacing: { after: 120 }, children: runs });
}

/** A generic data table with a shaded header row. `widthsDxa` must sum to CONTENT_WIDTH_DXA. */
export function dataTable(headers: string[], rows: string[][], widthsDxa: number[]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (h, i) =>
        new TableCell({
          width: { size: widthsDxa[i], type: WidthType.DXA },
          borders: cellBorders(),
          shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 16 })] })],
        }),
    ),
  });
  const bodyRows =
    rows.length > 0
      ? rows.map(
          (row) =>
            new TableRow({
              children: row.map(
                (cell, i) =>
                  new TableCell({
                    width: { size: widthsDxa[i], type: WidthType.DXA },
                    borders: cellBorders(),
                    children: [new Paragraph({ children: [new TextRun({ text: cell || "—", size: 16 })] })],
                  }),
              ),
            }),
        )
      : [
          new TableRow({
            children: headers.map(
              (_, i) =>
                new TableCell({
                  width: { size: widthsDxa[i], type: WidthType.DXA },
                  borders: cellBorders(),
                  children: i === 0 ? [new Paragraph({ children: [new TextRun({ text: "—", size: 16, color: "999999" })] })] : [new Paragraph({ children: [] })],
                }),
            ),
          }),
        ];
  return new Table({ width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA }, columnWidths: widthsDxa, rows: [headerRow, ...bodyRows] });
}

export const DOC_STYLES: IStylesOptions = {
  default: {
    document: { run: { font: "Calibri", size: 18 } },
  },
};

export function formatDateTimeMYT(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-MY", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kuala_Lumpur",
  }).format(d);
}

export function formatDateMYT(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kuala_Lumpur" }).format(d);
}
