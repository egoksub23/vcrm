import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashVerificationCode } from '@/lib/widget/verification-code';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

interface FakeState {
  pending: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  visitor: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
}
let state: FakeState;
const writes: { table: string; op: string; row?: unknown }[] = [];
const rpcCalls: { fn: string; args: unknown }[] = [];
let jwtVisitorId: string | null = 'visitor-1';

function chain(table: string) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) self[m] = () => self;
  self.update = (row: unknown) => {
    writes.push({ table, op: 'update', row });
    return self;
  };
  self.upsert = (row: unknown) => {
    writes.push({ table, op: 'upsert', row });
    return self;
  };
  self.delete = () => {
    writes.push({ table, op: 'delete' });
    return self;
  };
  self.maybeSingle = async () => {
    if (table === 'widget_verification_codes')
      return { data: state.pending, error: null };
    if (table === 'web_widget_config')
      return { data: state.config, error: null };
    if (table === 'widget_visitors')
      return { data: state.visitor, error: null };
    if (table === 'contacts') return { data: state.contact, error: null };
    return { data: null, error: null };
  };
  self.then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: null, error: null });
  return self;
}

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => chain(table),
    rpc: async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));

vi.mock('@/lib/widget/visitor-auth', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/widget/visitor-auth')
  >('@/lib/widget/visitor-auth');
  return { ...actual, verifyVisitorJwt: vi.fn(async () => jwtVisitorId) };
});

vi.mock('@/lib/api/v1/contacts', () => ({
  resolveAuditUserId: vi.fn(async () => 'owner-1'),
  ContactError: class ContactError extends Error {
    status = 500;
  },
}));

vi.mock('@/lib/widget/session-identity', () => ({
  findOrCreatePrimaryConversation: vi.fn(async () => 'conv-1'),
}));

import { POST } from './route';

const PENDING_CODE = '042817';

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    account_id: 'acc-1',
    widget_config_id: 'cfg-1',
    contact_id: 'contact-1',
    code_hash: hashVerificationCode(PENDING_CODE),
    attempts: 0,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...over,
  };
}

function configRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    account_id: 'acc-1',
    enabled: true,
    allowed_origins: [],
    name: 'Support',
    welcome_message: 'Hi',
    primary_color: '#000000',
    avatar_url: null,
    position: 'right',
    verification_mode: 'email_code',
    ...over,
  };
}

function call(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return POST(
    new Request('https://crm.example/api/widget/verify-code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://site.example',
        Authorization: 'Bearer jwt',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  );
}

const visitorUpsert = () =>
  writes.find((w) => w.table === 'widget_visitors' && w.op === 'upsert')
    ?.row as Record<string, unknown>;

beforeEach(() => {
  __resetRateLimitForTests();
  jwtVisitorId = 'visitor-1';
  state = {
    pending: pendingRow(),
    config: configRow(),
    visitor: null,
    contact: {
      name: 'Real Customer',
      phone: '60123980112',
      email: 'real@example.com',
    },
  };
  writes.length = 0;
  rpcCalls.length = 0;
});

describe('POST /api/widget/verify-code', () => {
  it('401s with no CORS header when the bearer token is missing or invalid', async () => {
    let res = await call({ code: PENDING_CODE }, { Authorization: '' });
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();

    jwtVisitorId = null;
    res = await call({ code: PENDING_CODE });
    expect(res.status).toBe(401);
  });

  it('400s a malformed code before touching the database', async () => {
    const res = await call({ code: 'abc' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad_request');
  });

  it('400s "no verification in progress" when there is no pending row', async () => {
    state.pending = null;
    const res = await call({ code: PENDING_CODE });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('not_found');
  });

  it('403s an origin not on the allow-list', async () => {
    state.config = configRow({ allowed_origins: ['https://only.example'] });
    const res = await call({ code: PENDING_CODE });
    expect(res.status).toBe(403);
  });

  it('400s an expired code and deletes the row', async () => {
    state.pending = pendingRow({
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await call({ code: PENDING_CODE });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expired/i);
    expect(writes).toContainEqual({
      table: 'widget_verification_codes',
      op: 'delete',
    });
  });

  it('400s once attempts are exhausted and deletes the row', async () => {
    state.pending = pendingRow({ attempts: 5 });
    const res = await call({ code: PENDING_CODE });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too many attempts/i);
    expect(writes).toContainEqual({
      table: 'widget_verification_codes',
      op: 'delete',
    });
  });

  it('400s an incorrect code and increments attempts, without consuming the row', async () => {
    const res = await call({ code: '000000' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Incorrect code');
    expect(writes).toContainEqual({
      table: 'widget_verification_codes',
      op: 'update',
      row: { attempts: 1 },
    });
    expect(
      writes.some(
        (w) => w.table === 'widget_verification_codes' && w.op === 'delete'
      )
    ).toBe(false);
  });

  it('a correct code verifies the visitor, consumes the code, and returns a chat session', async () => {
    const res = await call({ code: PENDING_CODE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      needsIdentity: false,
      conversationId: 'conv-1',
      identity: { level: 'verified', displayName: 'Real Customer' },
      claimFound: true,
    });
    expect(writes).toContainEqual({
      table: 'widget_verification_codes',
      op: 'delete',
    });
    expect(visitorUpsert()).toMatchObject({
      id: 'visitor-1',
      contact_id: 'contact-1',
      identity_level: 'verified',
      identity_source: 'code',
    });
    expect(rpcCalls).toEqual([]);
  });

  it('folds an existing GUEST browser contact into the verified contact', async () => {
    state.visitor = { contact_id: 'guest-contact', identity_level: 'guest' };
    await call({ code: PENDING_CODE });
    expect(rpcCalls).toEqual([
      {
        fn: 'merge_widget_guest_contact',
        args: {
          p_account_id: 'acc-1',
          p_guest_contact_id: 'guest-contact',
          p_target_contact_id: 'contact-1',
        },
      },
    ]);
  });

  it('never merges when the existing browser is already claimed/verified on a different contact', async () => {
    state.visitor = { contact_id: 'other-contact', identity_level: 'claimed' };
    await call({ code: PENDING_CODE });
    expect(rpcCalls).toEqual([]);
  });
});
