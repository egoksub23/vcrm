import { describe, expect, it } from 'vitest';

import { parseCsv, toCsv, unguardCsvCell } from './csv';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles CRLF, a BOM and blank lines', () => {
    expect(parseCsv('﻿a,b\r\n\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quoted commas, escaped quotes and embedded newlines', () => {
    expect(parseCsv('name,note\n"Smith, J","said ""hi""\nthere"\n')).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\nthere'],
    ]);
  });

  it('keeps empty cells and a final row with no trailing newline', () => {
    expect(parseCsv('a,,c\n1,2,')).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });
});

describe('toCsv', () => {
  it('quotes cells that need it', () => {
    expect(toCsv([['a', 'b,c', 'say "x"', 'l1\nl2']])).toBe('a,"b,c","say ""x""","l1\nl2"\r\n');
  });

  it('guards formula-looking cells, and unguard reverses it', () => {
    const csv = toCsv([['=SUM(A1)', '-5', '@x', 'ok']]);
    expect(csv).toBe("'=SUM(A1),'-5,'@x,ok\r\n");
    const [cells] = parseCsv(csv);
    expect(cells.map(unguardCsvCell)).toEqual(['=SUM(A1)', '-5', '@x', 'ok']);
  });

  it('leaves an ordinary leading apostrophe alone on import', () => {
    expect(unguardCsvCell("'tis")).toBe("'tis");
  });

  it('round-trips awkward values', () => {
    const rows = [
      ['name', 'description'],
      ['Refund, partial', 'He said "no"\nand left'],
      ['Ünïcode 한국어', ''],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
