import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveOrCreateContactByPhone, findOrCreatePrimaryConversation } from './session-identity';

type ContactRow = { id: string; phone: string; name?: string | null; wallet_id?: string | null; email?: string | null };

interface Script {
  contactCandidates?: ContactRow[];
  /** Per-call `.like` results — overrides contactCandidates. Lets a
   *  test simulate "miss, then hit" for the unique-race path. */
  contactCandidatesByCall?: ContactRow[][];
  insertedContactId?: string;
  insertContactError?: { code?: string } | null;
  existingConversation?: { id: string } | null;
  existingConversationByCall?: (({ id: string } | null))[];
  insertedConversationId?: string;
  insertConversationError?: { code?: string } | null;
}

function makeDb(script: Script): { db: SupabaseClient; updateCalls: { id: string; patch: Record<string, unknown> }[] } {
  let table = '';
  let mode: 'select' | 'insert' | 'update' = 'select';
  let convLookupCalls = 0;
  let likeCalls = 0;
  let lastEqId: string | undefined;
  const updateCalls: { id: string; patch: Record<string, unknown> }[] = [];

  const builder: Record<string, unknown> = {
    select: () => builder,
    insert: () => {
      mode = 'insert';
      return builder;
    },
    update: (patch: Record<string, unknown>) => {
      mode = 'update';
      (builder as { __patch?: Record<string, unknown> }).__patch = patch;
      return builder;
    },
    eq: (col: string, v: string) => {
      if (col === 'id') lastEqId = v;
      return builder;
    },
    order: () => builder,
    like: () => {
      const data = script.contactCandidatesByCall
        ? (script.contactCandidatesByCall[likeCalls] ?? [])
        : (script.contactCandidates ?? []);
      likeCalls++;
      return Promise.resolve({ data, error: null });
    },
    limit: () => {
      if (table === 'conversations' && mode === 'select') {
        const row = script.existingConversationByCall
          ? (script.existingConversationByCall[convLookupCalls] ?? null)
          : (script.existingConversation ?? null);
        convLookupCalls++;
        return Promise.resolve({ data: row ? [row] : [], error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
    single: () => {
      if (table === 'contacts' && mode === 'insert') {
        if (script.insertContactError) return Promise.resolve({ data: null, error: script.insertContactError });
        return Promise.resolve({ data: { id: script.insertedContactId }, error: null });
      }
      if (table === 'conversations' && mode === 'insert') {
        if (script.insertConversationError) return Promise.resolve({ data: null, error: script.insertConversationError });
        return Promise.resolve({ data: { id: script.insertedConversationId }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    then: (resolve: (v: { data: null; error: null }) => void) => {
      if (table === 'contacts' && mode === 'update' && lastEqId) {
        updateCalls.push({ id: lastEqId, patch: (builder as { __patch?: Record<string, unknown> }).__patch ?? {} });
      }
      resolve({ data: null, error: null });
    },
  };

  const db = {
    from: (t: string) => {
      table = t;
      mode = 'select';
      return builder;
    },
  } as unknown as SupabaseClient;

  return { db, updateCalls };
}

describe('resolveOrCreateContactByPhone', () => {
  it('creates a new contact with phone/wallet_id/email when no match exists', async () => {
    const { db } = makeDb({ contactCandidates: [], insertedContactId: 'ct-new' });
    const result = await resolveOrCreateContactByPhone(db, 'acct-1', 'owner-1', '+14155550123', {
      name: 'Jane',
      walletId: 'w-1',
      email: 'jane@x.com',
    });
    expect(result).toEqual({ contactId: 'ct-new', created: true });
  });

  it('matches an existing contact instead of creating a duplicate', async () => {
    const { db } = makeDb({ contactCandidates: [{ id: 'ct-1', phone: '+14155550123', name: 'Jane' }] });
    const result = await resolveOrCreateContactByPhone(db, 'acct-1', 'owner-1', '+14155550123', {});
    expect(result).toEqual({ contactId: 'ct-1', created: false });
  });

  it('backfills wallet_id/email onto an existing contact only where currently empty', async () => {
    const { db, updateCalls } = makeDb({
      contactCandidates: [{ id: 'ct-1', phone: '+14155550123', name: 'Jane', wallet_id: null, email: null }],
    });
    await resolveOrCreateContactByPhone(db, 'acct-1', 'owner-1', '+14155550123', {
      name: 'Someone Else', // has a name already — must NOT overwrite
      walletId: 'w-99',
      email: 'new@x.com',
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe('ct-1');
    // `name` is NOT in the patch — the existing contact already has one.
    expect(updateCalls[0].patch).toEqual({ wallet_id: 'w-99', email: 'new@x.com' });
  });

  it('does not touch a contact that already has wallet_id/email set', async () => {
    const { db, updateCalls } = makeDb({
      contactCandidates: [{ id: 'ct-1', phone: '+14155550123', wallet_id: 'existing-w', email: 'existing@x.com' }],
    });
    await resolveOrCreateContactByPhone(db, 'acct-1', 'owner-1', '+14155550123', {
      walletId: 'w-new',
      email: 'new@x.com',
    });
    expect(updateCalls).toHaveLength(0);
  });

  it('resolves the raced contact on a unique-violation instead of throwing', async () => {
    // First `like` (pre-insert findExistingContact) misses; the insert
    // then races and loses; the retry `like` finds the row that won.
    const { db } = makeDb({
      contactCandidatesByCall: [[], [{ id: 'ct-raced', phone: '+14155550123' }]],
      insertContactError: { code: '23505' },
    });
    const result = await resolveOrCreateContactByPhone(db, 'acct-1', 'owner-1', '+14155550123', {});
    expect(result).toEqual({ contactId: 'ct-raced', created: false });
  });
});

describe('findOrCreatePrimaryConversation', () => {
  it('returns the existing conversation without creating a new one', async () => {
    const { db } = makeDb({ existingConversation: { id: 'conv-1' } });
    const id = await findOrCreatePrimaryConversation(db, 'acct-1', 'owner-1', 'ct-1');
    expect(id).toBe('conv-1');
  });

  it('creates a new conversation when none exists', async () => {
    const { db } = makeDb({ existingConversation: null, insertedConversationId: 'conv-new' });
    const id = await findOrCreatePrimaryConversation(db, 'acct-1', 'owner-1', 'ct-1');
    expect(id).toBe('conv-new');
  });

  it('resolves the raced conversation on a unique-violation instead of throwing', async () => {
    const { db } = makeDb({
      existingConversationByCall: [null, { id: 'conv-raced' }],
      insertConversationError: { code: '23505' },
    });
    const id = await findOrCreatePrimaryConversation(db, 'acct-1', 'owner-1', 'ct-1');
    expect(id).toBe('conv-raced');
  });
});
