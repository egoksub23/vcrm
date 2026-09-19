/**
 * Minimal RFC-4180 CSV reader/writer for the Settings import/export
 * flows. The contacts importer predates this and splits on newlines, so
 * it can't hold a quoted cell containing a line break; this one can.
 *
 * Export guards against spreadsheet formula injection: a cell that
 * starts with = + - @ (or a tab / CR) gets a leading apostrophe, which
 * Excel and Sheets treat as "text". {@link unguardCsvCell} undoes exactly
 * that on import, so an export → import round trip is lossless.
 */

const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Parse CSV text into rows of cells. Tolerates a BOM, CRLF/LF and blank lines. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  // True once the current row has any content (a delimiter or a cell),
  // so a blank line isn't emitted as a row with one empty cell.
  let rowHasContent = false;

  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    if (rowHasContent) {
      endCell();
      rows.push(row);
    }
    row = [];
    cell = '';
    rowHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      rowHasContent = true;
    } else if (ch === ',') {
      endCell();
      rowHasContent = true;
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else {
      cell += ch;
      rowHasContent = true;
    }
  }
  endRow();
  return rows;
}

/** Serialise cells to one CSV line (no trailing newline). */
function csvLine(cells: string[]): string {
  return cells
    .map((raw) => {
      const value = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
      return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    })
    .join(',');
}

/** Serialise rows to CSV text (CRLF-terminated lines, UTF-8 BOM omitted — add at download). */
export function toCsv(rows: string[][]): string {
  return rows.map(csvLine).join('\r\n') + '\r\n';
}

/** Reverse of the export-side formula guard. */
export function unguardCsvCell(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

/**
 * Trigger a browser download of CSV text. A BOM is prepended so Excel
 * opens non-ASCII names (Korean, accented) as UTF-8.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
