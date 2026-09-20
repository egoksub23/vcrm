import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveImportTagIds } from './resolve-import-tags';

// Migration 084: an import matches only live, approved tags, and a person
// who can only PROPOSE tags never gets a tag created by an import.

function fakeDb(existing: { id: string; name: string }[]) {
  const eqCalls: [string, unknown][] = [];
  const isCalls: [string, unknown][] = [];
  const inserted: unknown[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe('tags');
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (column: string, value: unknown) => {
        eqCalls.push([column, value]);
        return b;
      };
      b.is = (column: string, value: unknown) => {
        isCalls.push([column, value]);
        return b;
      };
      b.insert = (rows: { name: string }[]) => {
        inserted.push(...rows);
        return {
          select: () =>
            Promise.resolve({
              data: rows.map((r, i) => ({ id: `new-${i}`, name: r.name })),
              error: null,
            }),
        };
      };
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: existing, error: null });
      return b;
    },
  } as unknown as SupabaseClient;
  return { db, eqCalls, isCalls, inserted };
}

const base = { accountId: 'a1', userId: 'u1' };

describe('resolveImportTagIds', () => {
  it('matches only live approved tags', async () => {
    const { db, eqCalls, isCalls } = fakeDb([{ id: 't1', name: 'VIP' }]);
    const out = await resolveImportTagIds(db, { ...base, tagNames: ['vip'], canCreateTags: false });
    expect(out.tagIdByKey.get('vip')).toBe('t1');
    expect(eqCalls).toContainEqual(['approval_status', 'approved']);
    expect(isCalls).toContainEqual(['deleted_at', null]);
  });

  it('skips unknown names instead of creating them for someone without tags.manage', async () => {
    const { db, inserted } = fakeDb([{ id: 't1', name: 'VIP' }]);
    const out = await resolveImportTagIds(db, {
      ...base,
      tagNames: ['VIP', 'Wholesale', 'wholesale'],
      canCreateTags: false,
    });
    expect(out.skippedNames).toEqual(['Wholesale']);
    expect(inserted).toEqual([]);
  });

  it('creates unknown names for someone who can manage tags', async () => {
    const { db, inserted } = fakeDb([]);
    const out = await resolveImportTagIds(db, { ...base, tagNames: ['Wholesale'], canCreateTags: true });
    expect(inserted).toHaveLength(1);
    expect(out.tagIdByKey.get('wholesale')).toBe('new-0');
    expect(out.skippedNames).toEqual([]);
  });
});
