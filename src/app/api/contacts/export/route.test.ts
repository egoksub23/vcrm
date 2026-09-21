import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  contactPages: [] as unknown[][],
  contactCalls: [] as { offset: number; end: number }[],
  inFilter: vi.fn(),
  orFilter: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireCapability: mocks.requireCapability,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'forbidden' }, { status: 403 })
  ),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(() => ({ success: true })),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));

import { GET } from './route';

function tagsBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order']) b[m] = vi.fn().mockReturnValue(b);
  b.range = vi.fn().mockResolvedValue({
    data: [{ id: 't1', name: 'VIP' }],
    error: null,
  });
  return b;
}

function contactsBuilder() {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) b[m] = vi.fn().mockReturnValue(b);
  b.in = vi.fn((...args: unknown[]) => {
    mocks.inFilter(...args);
    return b;
  });
  b.or = vi.fn((...args: unknown[]) => {
    mocks.orFilter(...args);
    return b;
  });
  b.range = vi.fn(async (offset: number, end: number) => {
    mocks.contactCalls.push({ offset, end });
    return { data: mocks.contactPages.shift() ?? [], error: null };
  });
  return b;
}

const supabase = {
  from: (table: string) => (table === 'tags' ? tagsBuilder() : contactsBuilder()),
};

function row(i: number) {
  return {
    id: `c${i}`,
    phone: `1555${String(i).padStart(4, '0')}`,
    name: `Person ${i}`,
    email: null,
    company: null,
    created_at: '2026-01-01T00:00:00Z',
    contact_tags: [{ tag_id: 't1' }],
  };
}

beforeEach(() => {
  mocks.contactPages = [];
  mocks.contactCalls = [];
  mocks.inFilter.mockReset();
  mocks.orFilter.mockReset();
  mocks.requireCapability.mockReset();
  mocks.requireCapability.mockResolvedValue({
    supabase,
    accountId: 'a1',
    userId: 'u1',
  });
});

describe('GET /api/contacts/export', () => {
  it('requires contacts.edit (same as Import)', async () => {
    mocks.contactPages = [[]];
    await GET(new Request('http://localhost/api/contacts/export'));
    expect(mocks.requireCapability).toHaveBeenCalledWith('contacts.edit');
  });

  it('pages through every batch instead of stopping at one page', async () => {
    // Page size is 500: a full first page means "ask for the next".
    mocks.contactPages = [
      Array.from({ length: 500 }, (_, i) => row(i)),
      Array.from({ length: 30 }, (_, i) => row(500 + i)),
    ];
    const res = await GET(new Request('http://localhost/api/contacts/export'));
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(
      /contacts-\d{4}-\d{2}-\d{2}\.csv/
    );
    const text = await res.text();
    const lines = text.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe('phone,name,email,company,tags,created_at');
    expect(lines).toHaveLength(1 + 530);
    expect(lines[1]).toContain('VIP');
    expect(mocks.contactCalls).toEqual([
      { offset: 0, end: 499 },
      { offset: 500, end: 999 },
    ]);
  });

  it('passes the search and tag filters to the query', async () => {
    mocks.contactPages = [[row(1)]];
    const tag = '11111111-1111-4111-8111-111111111111';
    const res = await GET(
      new Request(
        `http://localhost/api/contacts/export?q=${encodeURIComponent('ann,(x)')}&tag_ids=${tag},bad`
      )
    );
    await res.text();
    expect(mocks.inFilter).toHaveBeenCalledWith('tag_filter.tag_id', [tag]);
    expect(mocks.orFilter).toHaveBeenCalledWith(
      'name.ilike.%ann x%,phone.ilike.%ann x%,email.ilike.%ann x%'
    );
  });
});
