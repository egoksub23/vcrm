import { describe, expect, it } from 'vitest';

import {
  normalizeHexColor,
  parseTagCsv,
  planTagImport,
  tagsToCsv,
  type ExistingTag,
} from './tag-csv';

describe('normalizeHexColor', () => {
  it('normalises hex forms and preset names', () => {
    expect(normalizeHexColor('#ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('ef4444')).toBe('#ef4444');
    expect(normalizeHexColor(' Red ')).toBe('#ef4444');
  });
  it('rejects anything else', () => {
    expect(normalizeHexColor('#12')).toBeNull();
    expect(normalizeHexColor('chartreuse')).toBeNull();
    expect(normalizeHexColor('')).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
  });
});

describe('parseTagCsv', () => {
  it('reads a headed file, in any column order', () => {
    const { rows, issues } = parseTagCsv('color,Name,description\n#f00,Refund,Money back\n');
    expect(issues).toEqual([]);
    expect(rows).toEqual([
      { line: 2, name: 'Refund', description: 'Money back', color: '#ff0000', colorInvalid: false },
    ]);
  });

  it('accepts respond.io-style "category" headers', () => {
    const { rows } = parseTagCsv('Category,Description\nOTP,One-time codes\n');
    expect(rows.map((r) => r.name)).toEqual(['OTP']);
    expect(rows[0].color).toBeNull();
  });

  it('treats a file with no recognised header as headerless', () => {
    const { rows } = parseTagCsv('Sale,Promo enquiries,#10b981\nGuide\n');
    expect(rows.map((r) => [r.name, r.description, r.color])).toEqual([
      ['Sale', 'Promo enquiries', '#10b981'],
      ['Guide', null, null],
    ]);
    expect(rows[0].line).toBe(1);
  });

  it('flags an unusable colour but keeps the row', () => {
    const { rows } = parseTagCsv('name,color\nA,nope\nB,\n');
    expect(rows[0]).toMatchObject({ name: 'A', color: null, colorInvalid: true });
    expect(rows[1]).toMatchObject({ name: 'B', color: null, colorInvalid: false });
  });

  it('skips blank names, over-long values and in-file duplicates', () => {
    const long = 'x'.repeat(61);
    const { rows, issues } = parseTagCsv(`name,description\n,none\n${long},x\nDup,a\ndup,b\nOk,\n`);
    expect(rows.map((r) => r.name)).toEqual(['Dup', 'Ok']);
    expect(issues.map((i) => [i.line, i.reason])).toEqual([
      [2, 'missing_name'],
      [3, 'name_too_long'],
      [5, 'duplicate_in_file'],
    ]);
  });

  it('caps the number of rows', () => {
    const body = Array.from({ length: 2001 }, (_, i) => `Tag ${i}`).join('\n');
    const result = parseTagCsv(`name\n${body}`);
    expect(result.tooManyRows).toBe(true);
    expect(result.rows).toHaveLength(2000);
  });

  it('returns nothing for an empty file', () => {
    expect(parseTagCsv('')).toEqual({ rows: [], issues: [], tooManyRows: false });
  });
});

describe('tagsToCsv → parseTagCsv', () => {
  it('round-trips', () => {
    const tags = [
      { name: 'Refund, partial', description: 'He said "no"', color: '#ef4444' },
      { name: '-dash', description: null, color: '#3b82f6' },
    ];
    const { rows } = parseTagCsv(tagsToCsv(tags));
    expect(rows.map((r) => [r.name, r.description, r.color])).toEqual([
      ['Refund, partial', 'He said "no"', '#ef4444'],
      ['-dash', null, '#3b82f6'],
    ]);
  });
});

describe('planTagImport', () => {
  const existing: ExistingTag[] = [
    { id: '1', name: 'Refund', description: 'Old', color: '#ef4444', for_contacts: false, for_conversations: true },
    { id: '2', name: 'VIP', description: null, color: '#8b5cf6', for_contacts: true, for_conversations: false },
  ];
  const row = (name: string, description: string | null = null, color: string | null = null) => ({
    line: 2,
    name,
    description,
    color,
    colorInvalid: false,
  });

  it('creates new entries with the right list flag and a default colour', () => {
    const plan = planTagImport(existing, [row('Billing', 'Invoices')], 'label');
    expect(plan.create).toEqual([
      { name: 'Billing', description: 'Invoices', color: '#3b82f6', for_contacts: false, for_conversations: true },
    ]);
    const tagPlan = planTagImport(existing, [row('Newsletter', null, '#10b981')], 'tag');
    expect(tagPlan.create[0]).toMatchObject({ for_contacts: true, for_conversations: false, color: '#10b981' });
  });

  it('updates a changed description/colour and matches names case-insensitively', () => {
    const plan = planTagImport(existing, [row('refund', 'New text', '#f97316')], 'label');
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([{ id: '1', name: 'Refund', patch: { description: 'New text', color: '#f97316' } }]);
  });

  it('never erases stored values with blanks, and counts no-ops as unchanged', () => {
    const plan = planTagImport(existing, [row('Refund')], 'label');
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('switches an existing entry on for this list instead of duplicating it', () => {
    const plan = planTagImport(existing, [row('VIP')], 'label');
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([{ id: '2', name: 'VIP', patch: { for_conversations: true } }]);
    expect(plan.linkedFromOtherList).toBe(1);
  });
});
