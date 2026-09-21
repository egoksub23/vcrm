import { describe, expect, it } from 'vitest';

import { parseCsv } from '@/lib/csv';
import { parseContactCsv } from './parse-contact-csv';
import {
  CONTACT_EXPORT_HEADER,
  contactExportHeaderLine,
  contactExportLines,
  parseTagIdsParam,
  sanitizeContactSearch,
} from './export-csv';

const tags = new Map([
  ['t1', 'VIP'],
  ['t2', 'Lead, hot'],
  ['t3', 'Alpha'],
]);

describe('contactExportHeaderLine', () => {
  it('starts with the columns the importer reads', () => {
    expect(contactExportHeaderLine()).toBe(
      'phone,name,email,company,tags,created_at\r\n'
    );
    expect(CONTACT_EXPORT_HEADER.slice(0, 5)).toEqual([
      'phone',
      'name',
      'email',
      'company',
      'tags',
    ]);
  });
});

describe('contactExportLines', () => {
  it('returns nothing for an empty page', () => {
    expect(contactExportLines([], tags)).toBe('');
  });

  it('writes tag names sorted and semicolon separated', () => {
    const out = contactExportLines(
      [
        {
          phone: '15551230001',
          name: 'Ann',
          email: 'ann@x.com',
          company: 'Acme',
          created_at: '2026-01-02T03:04:05Z',
          contact_tags: [{ tag_id: 't1' }, { tag_id: 't3' }, { tag_id: 'gone' }],
        },
      ],
      tags
    );
    expect(parseCsv(out)).toEqual([
      ['15551230001', 'Ann', 'ann@x.com', 'Acme', 'Alpha; VIP', '2026-01-02T03:04:05Z'],
    ]);
  });

  it('quotes commas, quotes and newlines', () => {
    const out = contactExportLines(
      [
        {
          phone: '1',
          name: 'Smith, "Bob"',
          email: null,
          company: 'Line1\nLine2',
          created_at: null,
          contact_tags: [{ tag_id: 't2' }],
        },
      ],
      tags
    );
    expect(out).toContain('"Smith, ""Bob"""');
    expect(out).toContain('"Line1\nLine2"');
    expect(parseCsv(out)[0]).toEqual([
      '1',
      'Smith, "Bob"',
      '',
      'Line1\nLine2',
      'Lead, hot',
      '',
    ]);
  });

  it('guards cells that start with = + - @ against formula injection', () => {
    const out = contactExportLines(
      [
        {
          phone: '+447911123456',
          name: '=HYPERLINK("http://evil")',
          email: '-cmd',
          company: '@SUM(A1)',
          created_at: '2026-01-01',
          contact_tags: [],
        },
      ],
      tags
    );
    const [row] = parseCsv(out);
    expect(row[0]).toBe("'+447911123456");
    expect(row[1].startsWith("'=")).toBe(true);
    expect(row[2]).toBe("'-cmd");
    expect(row[3]).toBe("'@SUM(A1)");
  });

  it('round-trips through the importer parser', () => {
    const out =
      contactExportHeaderLine() +
      contactExportLines(
        [
          {
            phone: '+447911123456',
            name: 'Ann',
            email: 'ann@x.com',
            company: 'Acme',
            created_at: '2026-01-02',
            contact_tags: [{ tag_id: 't1' }, { tag_id: 't3' }],
          },
        ],
        tags
      );
    const parsed = parseContactCsv(out);
    expect(parsed.hasPhoneColumn).toBe(true);
    expect(parsed.rows).toEqual([
      {
        phone: '+447911123456',
        name: 'Ann',
        email: 'ann@x.com',
        company: 'Acme',
        tagNames: ['Alpha', 'VIP'],
      },
    ]);
  });
});

describe('sanitizeContactSearch', () => {
  it('drops characters that mean something in a PostgREST or() filter', () => {
    expect(sanitizeContactSearch('a,b)(c*d%e"f\\g')).toBe('a b c d e f g');
    expect(sanitizeContactSearch('  +44 7911  ')).toBe('+44 7911');
    expect(sanitizeContactSearch(null)).toBe('');
  });
});

describe('parseTagIdsParam', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  it('keeps unique UUIDs and drops junk', () => {
    expect(parseTagIdsParam(`${a}, ${b},${a},not-a-uuid,`)).toEqual([a, b]);
    expect(parseTagIdsParam('')).toEqual([]);
    expect(parseTagIdsParam(null)).toEqual([]);
  });
});
