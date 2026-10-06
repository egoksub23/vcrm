/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies and the query stub are read loosely in a test */
import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { decodeCursor } from '@/lib/api/v1/pagination';
import { A4, makePdf } from '@/lib/sign/pdf/fixtures';
import type { PlacedField } from '@/lib/sign/pdf/types';
import { createDocumentForApi, listDocumentsForApi } from '@/lib/sign/service/api';
import { FakeDb } from '@/lib/sign/service/fake-db';
import type { SignCtx } from '@/lib/sign/service/context';
import type { SignRole } from '@/lib/sign/types';

// ============================================================
// The Doc Sign public API, end to end through the route handlers: a fake key (the real key lookup is
// tested elsewhere), the real routes and services, and the in-memory database of the Doc Sign flow tests.
// What is NOT covered here: the real database functions, the real key table, real email.
// ============================================================

const A = '11111111-1111-4111-8111-111111111111';
const B = '99999999-9999-4999-8999-999999999999';
const USER = '22222222-2222-4222-8222-222222222222';
const TPL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TPL2 = 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb';
const TPL_ARCHIVED = 'aaaaaaaa-aaaa-4aaa-8aaa-cccccccccccc';
const TPL_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TOKEN = (n: number) => String(n).repeat(64).slice(0, 64);

const h = vi.hoisted(() => ({
  client: null as unknown,
  mail: [] as { to: string; subject: string; text: string }[],
}));

vi.mock('@/lib/auth/api-context', async () => {
  const respond = await import('@/lib/api/v1/respond');
  const KEYS: Record<string, { accountId: string; scopes: string[] }> = {
    'wacrm_live_write': { accountId: '11111111-1111-4111-8111-111111111111', scopes: ['sign:read', 'sign:write'] },
    'wacrm_live_read': { accountId: '11111111-1111-4111-8111-111111111111', scopes: ['sign:read'] },
    'wacrm_live_none': { accountId: '11111111-1111-4111-8111-111111111111', scopes: ['contacts:read'] },
    'wacrm_live_other': { accountId: '99999999-9999-4999-8999-999999999999', scopes: ['sign:read', 'sign:write'] },
  };
  return {
    requireApiKey: async (request: Request, scope?: string) => {
      const token = (request.headers.get('authorization') ?? '').replace('Bearer ', '');
      const key = KEYS[token];
      if (!key) throw respond.unauthorized();
      if (scope && !key.scopes.includes(scope)) throw respond.forbidden(`This API key is missing the '${scope}' scope`);
      return { authType: 'api_key', supabase: h.client, accountId: key.accountId, keyId: `key-${token}`, scopes: key.scopes, createdBy: '22222222-2222-4222-8222-222222222222', platform: {} };
    },
  };
});

vi.mock('@/lib/sign/notify', async (orig) => {
  const real = await orig<typeof import('@/lib/sign/notify')>();
  return {
    ...real,
    realDeps: {
      emailConfigured: () => true,
      sendEmail: async (a: { to: string; subject: string; text: string }) => void h.mail.push({ to: a.to, subject: a.subject, text: a.text }),
      loadIdentity: async () => ({ fromName: 'Vircle' }),
      sendWhatsApp: async () => {},
    },
  };
});

import { GET as listTemplates } from './templates/route';
import { GET as listDocuments, POST as createDocument } from './documents/route';
import { GET as getDocument } from './documents/[id]/route';
import { POST as voidDocument } from './documents/[id]/void/route';
import { POST as remindDocument } from './documents/[id]/remind/route';
import { POST as sendDocument } from './documents/[id]/send/route';
import { GET as getFile } from './documents/[id]/file/route';

const roles: SignRole[] = [
  { key: 'merchant', label: 'Merchant', kind: 'signer', color: 0 },
  { key: 'director', label: 'Director', kind: 'signer', color: 1 },
];
const fields: PlacedField[] = [
  { key: 'fee', type: 'static_text', role: 'sender', merge: 'fee_amount', label: 'Fee', page: 0, x: 0.1, y: 0.1, w: 0.5, h: 0.04, required: false },
  { key: 'bank', type: 'static_text', role: 'sender', merge: 'bank_name', page: 0, x: 0.1, y: 0.15, w: 0.5, h: 0.04, required: true },
  { key: 'msig', type: 'signature', role: 'merchant', page: 0, x: 0.1, y: 0.4, w: 0.4, h: 0.08, required: true },
  { key: 'dsig', type: 'signature', role: 'director', page: 0, x: 0.1, y: 0.6, w: 0.4, h: 0.08, required: true },
];

let db: FakeDb;
let pdf: Uint8Array;

async function seedTemplate(id: string, accountId: string, name: string, status = 'active') {
  const path = `account-${accountId}/templates/${id}/v1.pdf`;
  db.files.set(path, pdf);
  db.seed('sign_templates', [{ id, account_id: accountId, name, description: null, status, category_id: null, current_version_id: `ver-${id}` }]);
  db.seed('sign_template_versions', [
    { id: `ver-${id}`, account_id: accountId, template_id: id, version_no: 2, source_path: path, source_sha256: createHash('sha256').update(pdf).digest('hex'), original_path: null, page_count: 1, fields, roles, form: null, defaults: { expiry_days: 7, locale: 'ms' } },
  ]);
}

beforeEach(async () => {
  __resetRateLimitForTests();
  h.mail.length = 0;
  pdf = await makePdf([{ ...A4 }]);
  db = new FakeDb();
  db.seed('accounts', [{ id: A, name: 'Vircle Sdn Bhd', brand_name: null, timezone: 'Asia/Kuala_Lumpur' }]);
  db.seed('profiles', [{ user_id: USER, account_id: A, full_name: 'Gokula', email: 'gokula@vircle.example' }]);
  db.seed('sign_settings', [
    { id: 'set1', account_id: A, default_expiry_days: 14, reminder_days: [3, 7], default_language: 'en', consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: 'en' },
  ]);
  db.seed('accounts', [{ id: B, name: 'Other Sdn Bhd', brand_name: null, timezone: 'Asia/Kuala_Lumpur' }]);
  db.seed('sign_settings', [
    { id: 'set2', account_id: B, default_expiry_days: 14, reminder_days: [3, 7], default_language: 'en', consent_texts: {}, sender_name: null, retention_years: 7, certificate_id: null, whatsapp_template_name: null, whatsapp_template_language: 'en' },
  ]);
  db.seed('account_platform', [
    { account_id: A, status: 'active', features: { sign: true }, limits: {} },
    { account_id: B, status: 'active', features: { sign: true }, limits: {} },
  ]);
  db.seed('contacts', [
    { id: 'c1111111-1111-4111-8111-111111111111', account_id: A, deleted_at: null },
    { id: 'c2222222-2222-4222-8222-222222222222', account_id: B, deleted_at: null },
  ]);
  await seedTemplate(TPL, A, 'Merchant Application');
  await seedTemplate(TPL2, A, 'Terms of Service');
  await seedTemplate(TPL_ARCHIVED, A, 'Old Form', 'archived');
  await seedTemplate(TPL_OTHER, B, 'Someone Else');

  db.rpcHandlers.sign_log = async () => ({ data: null, error: null });
  db.rpcHandlers.sign_ensure_defaults = async () => ({ data: null, error: null });
  db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
  db.rpcHandlers.sign_send_document = async (args) => {
    const doc = db.rows('sign_documents').find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: 'sent', base_path: args.p_base_path, base_sha256: args.p_base_sha256, expires_at: args.p_expires_at, sent_at: '2026-10-06T08:00:00Z' });
    const people = db.rows('sign_signers').filter((s) => s.document_id === args.p_document);
    people.forEach((s) => Object.assign(s, { status: 'sent', invited_at: '2026-10-06T08:00:00Z' }));
    return {
      data: {
        reference: doc.reference ?? 'SGN-2026-000001',
        invited: people.map((s, i) => ({ signer_id: s.id, token: TOKEN(i + 1), name: s.full_name, email: s.email, phone: s.phone ?? null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no })),
      },
      error: null,
    };
  };
  db.rpcHandlers.sign_void_document = async (args) => {
    const doc = db.rows('sign_documents').find((d) => d.id === args.p_document)!;
    Object.assign(doc, { status: 'voided', void_reason: args.p_reason });
    return { data: {}, error: null };
  };
  db.rpcHandlers.sign_rotate_token = async (args) => {
    const s = db.rows('sign_signers').find((x) => x.id === args.p_signer)!;
    return { data: { signer_id: s.id, token: TOKEN(9), name: s.full_name, email: s.email, phone: null, channel: s.channel, role_key: s.role_key, kind: s.kind, order_no: s.order_no }, error: null };
  };
  h.client = db.client();
});

// ---- helpers -------------------------------------------------------------------------------------

type Key = 'write' | 'read' | 'none' | 'other' | 'bad' | null;
const call = (method: string, path: string, key: Key, body?: unknown) =>
  new Request(`https://halo.test/api/v1/sign${path}`, {
    method,
    headers: { ...(key ? { authorization: `Bearer wacrm_live_${key}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => (await res.json()) as { data?: any; error?: { code: string; message: string; issues?: any[] }; meta?: any };

const merchantBody = (over: Record<string, unknown> = {}) => ({
  template_id: TPL,
  reference: 'MERCHANT-1001',
  merge_values: { bank_name: 'Maybank', fee_amount: 'RM 1.00' },
  signers: [
    { role_key: 'merchant', full_name: 'Ali bin Ahmad', email: 'ali@kedairuncit.example' },
    { role_key: 'director', full_name: 'Gokula', email: 'g@vircle.example', order_no: 2 },
  ],
  ...over,
});

async function created(over: Record<string, unknown> = {}) {
  const res = await createDocument(call('POST', '/documents', 'write', merchantBody(over)));
  // the columns the real table fills by default
  db.rows('sign_signers').forEach((s) => (s.reminder_count ??= 0));
  return { res, body: await json(res) };
}

// ---- access ------------------------------------------------------------------------------------------

describe('access', () => {
  it('answers 401 without a key or with a wrong one', async () => {
    for (const key of [null, 'bad'] as Key[]) {
      const res = await listTemplates(call('GET', '/templates', key));
      expect(res.status).toBe(401);
      expect((await json(res)).error?.code).toBe('unauthorized');
    }
  });

  it('answers 403 forbidden when the key lacks the scope: sign:read for reads, sign:write for writes', async () => {
    expect((await listTemplates(call('GET', '/templates', 'none'))).status).toBe(403);
    expect((await listDocuments(call('GET', '/documents', 'none'))).status).toBe(403);
    const write = await createDocument(call('POST', '/documents', 'read', merchantBody()));
    expect(write.status).toBe(403);
    expect((await json(write)).error?.message).toContain('sign:write');
    expect((await voidDocument(call('POST', `/documents/${A}/void`, 'read', { reason: 'x' }), withId(A))).status).toBe(403);
    expect((await remindDocument(call('POST', `/documents/${A}/remind`, 'read', {}), withId(A))).status).toBe(403);
    expect((await sendDocument(call('POST', `/documents/${A}/send`, 'read'), withId(A))).status).toBe(403);
    expect(db.rows('sign_documents')).toHaveLength(0);
  });

  it('answers 403 sign_disabled for every route when the operator has Doc Sign off, and does nothing', async () => {
    db.rows('account_platform').find((r) => r.account_id === A)!.features = { sign: false };
    const answers = [
      await listTemplates(call('GET', '/templates', 'write')),
      await listDocuments(call('GET', '/documents', 'write')),
      await createDocument(call('POST', '/documents', 'write', merchantBody())),
      await getDocument(call('GET', `/documents/${A}`, 'write'), withId(A)),
      await getFile(call('GET', `/documents/${A}/file`, 'write'), withId(A)),
    ];
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect((await json(res)).error?.code).toBe('sign_disabled');
    }
    expect(db.rows('sign_documents')).toHaveLength(0);
    expect(h.mail).toHaveLength(0);
  });

  it('answers 403 sign_disabled when the workspace has no platform row at all', async () => {
    db.tables.account_platform = [];
    const res = await listTemplates(call('GET', '/templates', 'write'));
    expect(res.status).toBe(403);
  });
});

// ---- templates ------------------------------------------------------------------------------------------

describe('GET /templates', () => {
  it("lists this workspace's active templates with the roles and merge keys, and nothing else", async () => {
    const res = await listTemplates(call('GET', '/templates', 'write'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.meta).toEqual({ next_cursor: null });
    expect(body.data.map((t: any) => t.name)).toEqual(['Merchant Application', 'Terms of Service']);
    const t = body.data[0];
    expect(t).toMatchObject({ id: TPL, version: 2, page_count: 1, has_form: false, defaults: { expiry_days: 7, locale: 'ms', sign_in_order: null, code_required: null } });
    expect(t.roles).toEqual([
      { key: 'merchant', label: 'Merchant', kind: 'signer' },
      { key: 'director', label: 'Director', kind: 'signer' },
    ]);
    expect(t.merge_keys).toEqual([
      { key: 'fee_amount', label: 'Fee', required: false },
      { key: 'bank_name', label: null, required: true },
    ]);
    expect(JSON.stringify(body)).not.toContain(TPL_OTHER);
  });
});

// ---- create and send --------------------------------------------------------------------------------------

describe('POST /documents', () => {
  it('makes the document and sends it: 201, the people, what became of each message, and no link anywhere', async () => {
    const { res, body } = await created();
    expect(res.status).toBe(201);
    expect(res.headers.get('Idempotent-Replay')).toBeNull();
    expect(body.data).toMatchObject({ reference: 'MERCHANT-1001', status: 'sent', template_id: TPL, locale: 'ms', final_sha256: null, verify_url: null });
    expect(body.data.signers.map((s: any) => [s.role_key, s.full_name, s.status])).toEqual([
      ['merchant', 'Ali bin Ahmad', 'sent'],
      ['director', 'Gokula', 'sent'],
    ]);
    expect(body.data.invitations).toHaveLength(2);
    expect(body.data.invitations.every((i: any) => i.status === 'sent' && i.channel === 'email')).toBe(true);
    // the people were told, by email, with their own link
    expect(h.mail.map((m) => m.to).sort()).toEqual(['ali@kedairuncit.example', 'g@vircle.example']);
    // the document carries the caller's values and what the template defaults to
    const row = db.rows('sign_documents')[0];
    expect(row).toMatchObject({ reference: 'MERCHANT-1001', merge_values: { bank_name: 'Maybank', fee_amount: 'RM 1.00' }, created_by: USER, account_id: A });
    // never a link, token, code, address or device in what is returned
    const text = JSON.stringify(body);
    for (const secret of [TOKEN(1), TOKEN(2), '/s/', '"token"', '"ip"', '"device"', '"link"', 'wacrm_live']) expect(text).not.toContain(secret);
    expect(text).not.toContain('Maybank'); // merge values are not echoed
  });

  it('records that the call came through the API on what it logs', async () => {
    await created();
    const logged = db.rpcCalls.filter((c) => c.name === 'sign_log' && c.args.p_type === 'created');
    expect(logged).toHaveLength(1);
    expect(logged[0].args.p_detail).toMatchObject({ source: 'template', via: 'api_key:key-wacrm_live_write' });
    expect(logged[0].args.p_user).toBe(USER);
  });

  it('is idempotent on `reference`: the same reference returns the same document with 200 and creates and sends nothing', async () => {
    const first = await created();
    const mails = h.mail.length;
    const second = await created({ title: 'Something else' });
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get('Idempotent-Replay')).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.invitations).toBeUndefined();
    expect(db.rows('sign_documents')).toHaveLength(1);
    expect(db.rows('sign_signers')).toHaveLength(2);
    expect(h.mail).toHaveLength(mails);
    expect(db.rpcCalls.filter((c) => c.name === 'sign_send_document')).toHaveLength(1);
  });

  it('refuses a reference that was used for a document from another template', async () => {
    await created();
    const { res, body } = await created({ template_id: TPL2 });
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe('reference_conflict');
    expect(db.rows('sign_documents')).toHaveLength(1);
  });

  it("does not see another workspace's reference as a replay", async () => {
    await created();
    const other = await createDocument(call('POST', '/documents', 'other', merchantBody({ template_id: TPL_OTHER })));
    // its own template has no merge keys of ours: the fake template is the same fixture, so it is made, a second document
    expect(other.status).toBe(201);
    expect(db.rows('sign_documents').map((d) => d.account_id).sort()).toEqual([A, B].sort());
  });

  it('turns a database duplicate on the reference (two calls at once) into the first call\'s document', async () => {
    await created();
    // the pre-check misses (as it does when the other call has not committed yet); the insert then collides
    const real = db.client();
    let hidden = true;
    const client = {
      ...real,
      from: (table: string) => {
        if (table === 'sign_documents' && hidden) {
          const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ((hidden = false), { data: null, error: null }) };
          return q;
        }
        return real.from(table);
      },
    };
    db.failNext.sign_documents = 'duplicate key value violates unique constraint "sign_documents_reference"';
    const ctx: SignCtx = { admin: client as never, accountId: A, userId: USER, origin: 'https://halo.test', deps: (await import('@/lib/sign/notify')).realDeps, now: () => new Date('2026-10-06T08:00:00Z') };
    const out = await createDocumentForApi(ctx, { templateId: TPL, reference: 'MERCHANT-1001', title: null, contactId: null, signers: [{ roleKey: 'merchant', fullName: 'Ali', email: 'ali@x.example', phone: null, channel: 'email', orderNo: null }], mergeValues: {}, message: null, locale: null, expiresInDays: null, signInOrder: null, codeRequired: null, send: true });
    expect(out.replay).toBe(true);
    expect(db.rows('sign_documents')).toHaveLength(1);
  });

  it('answers 409 reference_in_use when the database refuses the reference and no document is found', async () => {
    db.failNext.sign_documents = 'duplicate key value violates unique constraint "sign_documents_reference"';
    const { res, body } = await created();
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe('reference_in_use');
  });

  it('works without a reference (and then there is no idempotency, said in the docs)', async () => {
    const a = await created({ reference: undefined });
    const b = await created({ reference: undefined });
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    expect(db.rows('sign_documents')).toHaveLength(2);
  });

  it('applies the choices given: title, contact, message, language, days to sign, order, code', async () => {
    const { res, body } = await created({ title: 'Kedai Runcit', contact_id: 'c1111111-1111-4111-8111-111111111111', message: 'Please sign today.', locale: 'zh', expires_in_days: 3, sign_in_order: true, code_required: true });
    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({ title: 'Kedai Runcit', contact_id: 'c1111111-1111-4111-8111-111111111111', locale: 'zh', sign_in_order: true, code_required: true });
    expect(db.rows('sign_documents')[0]).toMatchObject({ message: 'Please sign today.' });
    const sendCall = db.rpcCalls.find((c) => c.name === 'sign_send_document')!;
    expect(new Date(sendCall.args.p_expires_at as string).getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
    expect(new Date(sendCall.args.p_expires_at as string).getTime()).toBeLessThan(Date.now() + 3.1 * 86_400_000);
  });

  it("refuses a contact of another workspace without saying more, and leaves nothing behind", async () => {
    const { res, body } = await created({ contact_id: 'c2222222-2222-4222-8222-222222222222' });
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('contact_not_found');
    expect(db.rows('sign_documents')).toHaveLength(0);
  });

  it("answers 404 for a template of another workspace or an archived one, 409 not active for the archived", async () => {
    const other = await created({ template_id: TPL_OTHER });
    expect(other.res.status).toBe(404);
    expect(other.body.error?.code).toBe('template_not_found');
    const archived = await created({ template_id: TPL_ARCHIVED });
    expect(archived.res.status).toBe(409);
    expect(archived.body.error?.code).toBe('template_not_active');
  });

  it('with send:false leaves a draft and sends nothing; POST /send then sends it once', async () => {
    const draft = await created({ send: false });
    expect(draft.res.status).toBe(201);
    expect(draft.body.data.status).toBe('draft');
    expect(draft.body.data.invitations).toEqual([]);
    expect(h.mail).toHaveLength(0);

    const sent = await sendDocument(call('POST', `/documents/${draft.body.data.id}/send`, 'write'), withId(draft.body.data.id));
    expect(sent.status).toBe(200);
    const body = await json(sent);
    expect(body.data.status).toBe('sent');
    expect(body.data.invitations).toHaveLength(2);
    expect(h.mail).toHaveLength(2);

    const again = await sendDocument(call('POST', `/documents/${draft.body.data.id}/send`, 'write'), withId(draft.body.data.id));
    expect(again.status).toBe(409);
    expect((await json(again)).error?.code).toBe('document_not_draft');
    expect(h.mail).toHaveLength(2);
  });

  it('gives back a replay of a draft as the draft it is', async () => {
    await created({ send: false });
    const again = await created({ send: false });
    expect(again.res.status).toBe(200);
    expect(again.body.data.status).toBe('draft');
    expect(db.rows('sign_documents')).toHaveLength(1);
  });

  it('is all or nothing: a send that cannot happen (monthly limit) deletes the draft so a retry starts clean', async () => {
    db.rpcHandlers.account_usage = async () => ({ data: { limits: { sign_documents_per_month: 5 }, sign_documents_month: 5 }, error: null });
    const { res, body } = await created();
    expect(res.status).toBe(429);
    expect(body.error?.code).toBe('sign_limit_reached');
    expect(db.rows('sign_documents')).toHaveLength(0); // (the people go with it by cascade in the real database)
    expect(h.mail).toHaveLength(0);
    // limit raised: the same call, same reference, now goes through
    db.rpcHandlers.account_usage = async () => ({ data: { limits: {}, sign_documents_month: 0 }, error: null });
    expect((await created()).res.status).toBe(201);
  });

  it('is all or nothing when the people do not fit the template: 400 listing each problem, nothing left', async () => {
    const { res, body } = await created({
      merge_values: { fee_amount: 'RM 1', nonsense: 'x' },
      signers: [{ role_key: 'ghost', full_name: 'Ali', email: 'ali@x.example' }],
    });
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('invalid_request');
    const codes = body.error?.issues?.map((i: any) => `${i.code}:${i.field}`);
    expect(codes).toEqual(expect.arrayContaining(['unknown_role:signers[0].role_key', 'unknown_merge_key:merge_values.nonsense', 'merge_value_missing:merge_values.bank_name']));
    expect(body.error?.issues?.find((i: any) => i.code === 'unknown_role').detail).toBe('merchant, director'); // the valid keys
    expect(db.rows('sign_documents')).toHaveLength(0);
  });

  it('is not ready to send when a role has no person: 400 not_ready with the issues, nothing left', async () => {
    const { res, body } = await created({ signers: [{ role_key: 'merchant', full_name: 'Ali', email: 'ali@x.example' }] });
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('not_ready');
    expect(body.error?.issues?.map((i: any) => i.code)).toContain('role_without_person');
    expect(db.rows('sign_documents')).toHaveLength(0);
  });

  it('reports a message that could not be delivered as a status, never as a link', async () => {
    const real = (await import('@/lib/sign/notify')).realDeps;
    const original = real.sendEmail;
    (real as { sendEmail: unknown }).sendEmail = async () => {
      throw new Error('Resend: domain not verified');
    };
    try {
      const { res, body } = await created();
      expect(res.status).toBe(201);
      expect(body.data.invitations.map((i: any) => i.status)).toEqual(['failed', 'failed']);
      expect(JSON.stringify(body)).not.toContain('/s/');
      expect(JSON.stringify(body)).not.toContain('domain not verified');
    } finally {
      (real as { sendEmail: unknown }).sendEmail = original;
    }
  });
});

describe('POST /documents validation', () => {
  const bad = async (body: unknown) => {
    const res = await createDocument(call('POST', '/documents', 'write', body));
    return { res, body: await json(res) };
  };
  const fieldsOf = (b: { error?: { issues?: any[] } }) => (b.error?.issues ?? []).map((i) => i.field);

  it('rejects what is not a JSON object, with a stable code', async () => {
    for (const raw of ['not json', '[1,2]', '"x"']) {
      const { res, body } = await bad(raw);
      expect(res.status).toBe(400);
      expect(body.error?.code).toBe('bad_json');
    }
    expect((await bad('x'.repeat(250_000))).res.status).toBe(413);
  });

  it('lists every problem at once, naming the field', async () => {
    const { res, body } = await bad({
      template_id: 'nope',
      reference: 'has space',
      title: 5,
      contact_id: 'x',
      signers: [{ role_key: '', full_name: '', email: 'not-an-email', channel: 'sms', phone: '012', order_no: 0 }, 'x'],
      merge_values: { 'bad key': 'x', n: { a: 1 }, ok: 12 },
      message: 'm'.repeat(2001),
      locale: 'fr',
      expires_in_days: 0,
      sign_in_order: 'yes',
      code_required: 1,
      send: 'true',
    });
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe('bad_request');
    expect(fieldsOf(body)).toEqual(
      expect.arrayContaining([
        'template_id', 'reference', 'title', 'contact_id',
        'signers[0].role_key', 'signers[0].full_name', 'signers[0].email', 'signers[0].channel', 'signers[0].phone', 'signers[0].order_no', 'signers[1]',
        'merge_values.bad key', 'merge_values.n', 'message', 'locale', 'expires_in_days', 'sign_in_order', 'code_required', 'send',
      ]),
    );
    expect(fieldsOf(body)).not.toContain('merge_values.ok');
    expect(db.rows('sign_documents')).toHaveLength(0);
  });

  it('needs at least one person, at most 20, and a phone for WhatsApp', async () => {
    expect(fieldsOf((await bad(merchantBody({ signers: [] }))).body)).toEqual(['signers']);
    expect(fieldsOf((await bad(merchantBody({ signers: undefined }))).body)).toEqual(['signers']);
    const many = Array.from({ length: 21 }, (_, i) => ({ role_key: 'merchant', full_name: `P${i}`, email: `p${i}@x.example` }));
    expect(fieldsOf((await bad(merchantBody({ signers: many }))).body)).toEqual(['signers']);
    const wa = await bad(merchantBody({ signers: [{ role_key: 'merchant', full_name: 'Ali', email: 'a@x.example', channel: 'whatsapp' }] }));
    expect(fieldsOf(wa.body)).toEqual(['signers[0].phone']);
  });

  it("does not let a caller pick a reference in the system's own numbering, which would collide later", async () => {
    expect(fieldsOf((await bad(merchantBody({ reference: 'SGN-2026-000123' }))).body)).toEqual(['reference']);
    expect(fieldsOf((await bad(merchantBody({ reference: 'sgn-2026-1' }))).body)).toEqual(['reference']);
    expect(fieldsOf((await bad(merchantBody({ reference: 'x'.repeat(65) }))).body)).toEqual(['reference']);
  });

  it('ignores fields it does not know, like the other v1 routes', async () => {
    const { res } = await created({ surprise: true, signers: merchantBody().signers.map((s) => ({ ...s, nickname: 'x' })) });
    expect(res.status).toBe(201);
  });

  it('accepts numbers and true/false in merge values and writes them as text', async () => {
    await created({ merge_values: { bank_name: 'Maybank', fee_amount: 1.5 } });
    expect(db.rows('sign_documents')[0].merge_values).toEqual({ bank_name: 'Maybank', fee_amount: '1.5' });
  });

  it('normalises a phone number', async () => {
    await created({
      signers: [
        { role_key: 'merchant', full_name: 'Ali', email: 'ali@x.example', channel: 'whatsapp', phone: '+60 12-345 6789' },
        { role_key: 'director', full_name: 'Gokula', email: 'g@x.example' },
      ],
    });
    expect(db.rows('sign_signers').find((s) => s.role_key === 'merchant')!.phone).toBe('+60123456789');
  });
});

// ---- reading one -------------------------------------------------------------------------------------------

describe('GET /documents/{id}', () => {
  it('shows the status and each person, without anything private to a signer', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    const signer = db.rows('sign_signers').find((s) => s.role_key === 'merchant')!;
    Object.assign(signer, { status: 'signed', signed_at: '2026-10-06T09:00:00Z', ip: '203.0.113.9', device: 'Mozilla/5.0 (iPhone)', consent_version: 'v1', phone: '+60123456789' });
    const res = await getDocument(call('GET', `/documents/${id}`, 'read'), withId(id));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toMatchObject({ id, status: 'sent', reference: 'MERCHANT-1001', progress: null });
    expect(body.data.signers.find((s: any) => s.role_key === 'merchant')).toMatchObject({ status: 'signed', signed_at: '2026-10-06T09:00:00Z', email: 'ali@kedairuncit.example' });
    const text = JSON.stringify(body);
    for (const secret of ['203.0.113.9', 'Mozilla', 'consent', '+60123456789', 'account-', 'base_path', 'final_path', TOKEN(1)]) expect(text).not.toContain(secret);
    // only these members may ever appear on a person (an unset one is simply absent from the JSON)
    const allowed = ['channel', 'decline_reason', 'declined_at', 'email', 'full_name', 'id', 'invited_at', 'kind', 'last_reminded_at', 'order_no', 'reminder_count', 'role_key', 'signed_at', 'status', 'viewed_at'];
    for (const person of body.data.signers) expect(Object.keys(person).filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it('shows the fingerprint and the verify address only once completed', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    Object.assign(db.rows('sign_documents')[0], { status: 'completed', completed_at: '2026-10-07T01:00:00Z', final_path: `account-${A}/${id}/final/x.pdf`, final_sha256: 'f'.repeat(64) });
    const body = await json(await getDocument(call('GET', `/documents/${id}`, 'read'), withId(id)));
    expect(body.data).toMatchObject({ status: 'completed', final_sha256: 'f'.repeat(64), completed_at: '2026-10-07T01:00:00Z' });
    expect(body.data.verify_url).toBe(`https://halo.test/verify/${id}`);
  });

  it("answers 404 with no hint for another workspace's document, a missing one, and an id that is not one", async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    const answers = [
      await getDocument(call('GET', `/documents/${id}`, 'other'), withId(id)),
      await getDocument(call('GET', `/documents/${B}`, 'write'), withId(B)),
      await getDocument(call('GET', '/documents/abc', 'write'), withId('abc')),
    ];
    const bodies = [];
    for (const res of answers) {
      expect(res.status).toBe(404);
      bodies.push(await json(res));
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0].error?.code).toBe('document_not_found');
  });

  it("never shows another workspace's document to a key of this one, for any write route either", async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    expect((await voidDocument(call('POST', `/documents/${id}/void`, 'other', { reason: 'x' }), withId(id))).status).toBe(404);
    expect((await remindDocument(call('POST', `/documents/${id}/remind`, 'other', {}), withId(id))).status).toBe(404);
    expect((await sendDocument(call('POST', `/documents/${id}/send`, 'other'), withId(id))).status).toBe(404);
    expect((await getFile(call('GET', `/documents/${id}/file`, 'other'), withId(id))).status).toBe(404);
    expect(db.rows('sign_documents')[0].status).toBe('sent');
  });
});

// ---- void ----------------------------------------------------------------------------------------------------

describe('POST /documents/{id}/void', () => {
  it('cancels a sent document with the reason, and a second call changes nothing', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    const res = await voidDocument(call('POST', `/documents/${id}/void`, 'write', { reason: 'Wrong fee' }), withId(id));
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ status: 'voided', void_reason: 'Wrong fee' });
    const voids = db.rpcCalls.filter((c) => c.name === 'sign_void_document').length;
    const again = await voidDocument(call('POST', `/documents/${id}/void`, 'write', { reason: 'Wrong fee' }), withId(id));
    expect(again.status).toBe(200);
    expect(db.rpcCalls.filter((c) => c.name === 'sign_void_document')).toHaveLength(voids);
  });

  it('needs a reason', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    for (const body of [{}, { reason: '  ' }, { reason: 5 }]) {
      const res = await voidDocument(call('POST', `/documents/${id}/void`, 'write', body), withId(id));
      expect(res.status).toBe(400);
      expect((await json(res)).error?.code).toBe('reason_required');
    }
    expect(db.rows('sign_documents')[0].status).toBe('sent');
  });

  it.each(['completed', 'declined', 'expired', 'sealing', 'failed'])('is a 409 document_not_open for a document that is %s', async (status) => {
    const { body: made } = await created();
    const id = made.data.id as string;
    db.rows('sign_documents')[0].status = status;
    const res = await voidDocument(call('POST', `/documents/${id}/void`, 'write', { reason: 'x' }), withId(id));
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('document_not_open');
    expect(db.rows('sign_documents')[0].status).toBe(status);
  });
});

// ---- remind --------------------------------------------------------------------------------------------------

describe('POST /documents/{id}/remind', () => {
  const NOW = () => new Date().toISOString();
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  it('reminds everyone waiting, with a fresh link by email and never the link in the answer', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    h.mail.length = 0;
    const res = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', {}), withId(id));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.invitations).toHaveLength(2);
    expect(body.data.invitations.every((i: any) => i.status === 'sent')).toBe(true);
    expect(body.data.held).toEqual([]);
    expect(h.mail).toHaveLength(2);
    expect(h.mail[0].text).toContain(TOKEN(9)); // the person gets it
    expect(JSON.stringify(body)).not.toContain(TOKEN(9));
    expect(db.rows('sign_signers').every((s) => s.reminder_count === 1 && typeof s.last_reminded_at === 'string')).toBe(true);
    expect(db.rpcCalls.filter((c) => c.name === 'sign_rotate_token').every((c) => c.args.p_reason === 'reminded')).toBe(true);
  });

  it('holds back someone reminded less than 24 hours ago: 409 for one person, listed as held for everyone', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    const [first, second] = db.rows('sign_signers');
    first.last_reminded_at = ago(3);
    first.reminder_count = 1;
    h.mail.length = 0;

    const one = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', { signer_id: first.id }), withId(id));
    expect(one.status).toBe(409);
    expect((await json(one)).error?.code).toBe('remind_too_soon');
    expect(h.mail).toHaveLength(0);

    const all = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', {}), withId(id));
    expect(all.status).toBe(200);
    const body = await json(all);
    expect(body.data.invitations.map((i: any) => i.signer_id)).toEqual([second.id]);
    expect(body.data.held).toHaveLength(1);
    expect(body.data.held[0].signer_id).toBe(first.id);
    expect(new Date(body.data.held[0].retry_at).getTime()).toBeGreaterThan(Date.now());
    expect(h.mail).toHaveLength(1);

    // after a day it goes again
    first.last_reminded_at = ago(25);
    const later = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', { signer_id: first.id }), withId(id));
    expect(later.status).toBe(200);
  });

  it('is a 409 when nobody can be reminded', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    db.rows('sign_signers').forEach((s) => Object.assign(s, { last_reminded_at: NOW(), reminder_count: 1 }));
    const all = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', {}), withId(id));
    expect(all.status).toBe(409);
    expect((await json(all)).error?.code).toBe('remind_too_soon');
    db.rows('sign_signers').forEach((s) => (s.status = 'signed'));
    const none = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', {}), withId(id));
    expect(none.status).toBe(409);
    expect((await json(none)).error?.code).toBe('nobody_to_remind');
    const one = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', { signer_id: db.rows('sign_signers')[0].id }), withId(id));
    expect((await json(one)).error?.code).toBe('signer_not_open');
  });

  it('is a 409 for a document that is not waiting, 404 for a person who is not on it, 400 for a bad id', async () => {
    const { body: made } = await created();
    const id = made.data.id as string;
    const ghost = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', { signer_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }), withId(id));
    expect(ghost.status).toBe(404);
    expect((await json(ghost)).error?.code).toBe('signer_not_found');
    const junk = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', { signer_id: 'x' }), withId(id));
    expect(junk.status).toBe(400);
    db.rows('sign_documents')[0].status = 'completed';
    const done = await remindDocument(call('POST', `/documents/${id}/remind`, 'write', {}), withId(id));
    expect(done.status).toBe(409);
    expect((await json(done)).error?.code).toBe('document_not_open');
  });
});

// ---- files ---------------------------------------------------------------------------------------------------

describe('GET /documents/{id}/file', () => {
  async function completed() {
    const { body: made } = await created();
    const id = made.data.id as string;
    const bytes = await makePdf([{ ...A4 }, { ...A4 }]);
    const finalPath = `account-${A}/${id}/final/sealed.pdf`;
    db.files.set(finalPath, bytes);
    return { id, bytes, finalPath, row: db.rows('sign_documents')[0] };
  }

  it('refuses the signed copy before the document is completed, in every state', async () => {
    const { id, finalPath, row } = await completed();
    for (const status of ['draft', 'sent', 'in_progress', 'sealing', 'failed', 'voided', 'declined', 'expired']) {
      Object.assign(row, { status, final_path: null, final_sha256: null });
      expect((await getFile(call('GET', `/documents/${id}/file`, 'read'), withId(id))).status).toBe(409);
      // even with a stored path (a sealing document that has one cannot be handed out before it is completed)
      Object.assign(row, { final_path: finalPath, final_sha256: 'a'.repeat(64) });
      const res = await getFile(call('GET', `/documents/${id}/file?kind=signed`, 'read'), withId(id));
      expect(res.status).toBe(409);
      expect((await json(res)).error?.code).toBe('not_completed');
    }
    expect(db.rpcCalls.some((c) => c.name === 'sign_log' && c.args.p_type === 'downloaded')).toBe(false);
  });

  it('streams the signed copy once completed, as an attachment with its fingerprint, and records the download', async () => {
    const { id, bytes, finalPath, row } = await completed();
    const sha = createHash('sha256').update(bytes).digest('hex');
    Object.assign(row, { status: 'completed', final_path: finalPath, final_sha256: sha });
    const res = await getFile(call('GET', `/documents/${id}/file?kind=signed`, 'read'), withId(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="MERCHANT-1001-signed.pdf"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-sha256')).toBe(sha);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const logged = db.rpcCalls.find((c) => c.name === 'sign_log' && c.args.p_type === 'downloaded')!;
    expect(logged.args.p_detail).toMatchObject({ kind: 'final', via: 'api_key:key-wacrm_live_read' });
    // the default kind is the signed copy
    expect((await getFile(call('GET', `/documents/${id}/file`, 'read'), withId(id))).status).toBe(200);
  });

  it('refuses a stored path that is not in this workspace folder', async () => {
    const { id, row } = await completed();
    db.files.set(`account-${B}/x/final/y.pdf`, new Uint8Array([1]));
    Object.assign(row, { status: 'completed', final_path: `account-${B}/x/final/y.pdf`, final_sha256: 'a'.repeat(64) });
    const res = await getFile(call('GET', `/documents/${id}/file`, 'read'), withId(id));
    expect(res.status).toBe(404);
  });

  it('says the certificate is part of the signed copy, and answers 404 for a missing original and 400 for an unknown kind', async () => {
    const { id, finalPath, row } = await completed();
    Object.assign(row, { status: 'completed', final_path: finalPath, final_sha256: 'a'.repeat(64) });
    const cert = await getFile(call('GET', `/documents/${id}/file?kind=certificate`, 'read'), withId(id));
    expect(cert.status).toBe(404);
    const c = await json(cert);
    expect(c.error?.code).toBe('no_separate_certificate');
    expect(c.error?.message).toContain('kind=signed');
    const original = await getFile(call('GET', `/documents/${id}/file?kind=original`, 'read'), withId(id));
    expect(original.status).toBe(404);
    expect((await json(original)).error?.code).toBe('no_original_file');
    const kind = await getFile(call('GET', `/documents/${id}/file?kind=base`, 'read'), withId(id));
    expect(kind.status).toBe(400);
  });

  it('hands out the original as received when the document has one, in any state', async () => {
    const { id, row } = await completed();
    db.files.set(`account-${A}/${id}/source/a.docx`, new Uint8Array([7, 7]));
    Object.assign(row, { original_path: `account-${A}/${id}/source/a.docx`, original_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', original_sha256: 'e'.repeat(64) });
    const res = await getFile(call('GET', `/documents/${id}/file?kind=original`, 'read'), withId(id));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('MERCHANT-1001-original.docx');
  });
});

// ---- the list ------------------------------------------------------------------------------------------------

/** A client that records the calls of a query and answers with the rows it was given. FakeDb has no `or`/`gt`, which the list uses. */
function stub(rows: { documents: Record<string, unknown>[]; signers?: Record<string, unknown>[]; versions?: Record<string, unknown>[] }) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const client = {
    from(table: string) {
      const ops: [string, unknown[]][] = [];
      calls.push({ table, ops });
      const answer = () => (table === 'sign_documents' ? rows.documents : table === 'sign_signers' ? (rows.signers ?? []) : table === 'sign_template_versions' ? (rows.versions ?? []) : []);
      const q: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: answer(), error: null }).then(res, rej);
            if (prop === 'maybeSingle') return async () => ({ data: table === 'account_platform' ? { status: 'active', features: { sign: true } } : null, error: null });
            return (...args: unknown[]) => (ops.push([String(prop), args]), q);
          },
        },
      );
      return q;
    },
  };
  return { client, calls, opsOf: (table: string) => calls.filter((c) => c.table === table).map((c) => c.ops) };
}

const doc = (n: number, over: Record<string, unknown> = {}) => ({
  id: `d0000000-0000-4000-8000-00000000000${n}`,
  reference: `REF-${n}`,
  title: `Doc ${n}`,
  status: 'sent',
  template_version_id: `ver-${TPL}`,
  contact_id: null,
  locale: 'en',
  sign_in_order: false,
  code_required: false,
  expires_at: null,
  sent_at: null,
  completed_at: null,
  final_sha256: null,
  void_reason: null,
  page_count: 1,
  created_at: `2026-10-0${n}T08:00:00.000Z`,
  updated_at: `2026-10-0${n}T08:00:00.000Z`,
  ...over,
});

describe('GET /documents', () => {
  it('pages by keyset: asks for one more than the page, scopes to the workspace, and hands back a cursor to the next', async () => {
    const s = stub({
      documents: [doc(3), doc(2), doc(1)],
      signers: [
        { document_id: doc(3).id, status: 'signed' },
        { document_id: doc(3).id, status: 'sent' },
        { document_id: doc(2).id, status: 'signed' },
      ],
      versions: [{ id: `ver-${TPL}`, template_id: TPL }],
    });
    h.client = s.client;
    const res = await listDocuments(call('GET', '/documents?limit=2', 'read'));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.map((d: any) => d.reference)).toEqual(['REF-3', 'REF-2']);
    expect(body.data[0]).toMatchObject({ template_id: TPL, signers_total: 2, signers_signed: 1 });
    expect(body.data[0].signers).toBeUndefined();
    const cursor = decodeCursor(body.meta.next_cursor);
    expect(cursor).toEqual({ createdAt: doc(2).created_at, id: doc(2).id });

    const ops = s.opsOf('sign_documents')[0];
    expect(ops).toContainEqual(['eq', ['account_id', A]]);
    expect(ops).toContainEqual(['limit', [3]]);
    expect(ops.some(([name]) => name === 'or')).toBe(false);
    // the signers and versions of the page are read with the workspace too
    expect(s.opsOf('sign_signers')[0]).toContainEqual(['eq', ['account_id', A]]);
    expect(s.opsOf('sign_template_versions')[0]).toContainEqual(['eq', ['account_id', A]]);

    // the next page continues after the cursor
    await listDocuments(call('GET', `/documents?limit=2&cursor=${body.meta.next_cursor}`, 'read'));
    const next = s.opsOf('sign_documents')[1];
    expect(next.find(([name]) => name === 'or')![1][0]).toContain(doc(2).id);
  });

  it('ends with next_cursor null on the last page', async () => {
    h.client = stub({ documents: [doc(2), doc(1)] }).client;
    const body = await json(await listDocuments(call('GET', '/documents?limit=5', 'read')));
    expect(body.meta.next_cursor).toBeNull();
    expect(body.data).toHaveLength(2);
  });

  it('applies the filters, always with the account', async () => {
    const s = stub({ documents: [], versions: [{ id: `ver-${TPL}`, template_id: TPL }] });
    h.client = s.client;
    const url = `/documents?status=completed&contact_id=c1111111-1111-4111-8111-111111111111&template_id=${TPL}&reference=REF-9&created_after=2026-10-01`;
    const res = await listDocuments(call('GET', url, 'read'));
    expect(res.status).toBe(200);
    const ops = s.opsOf('sign_documents')[0];
    expect(ops).toContainEqual(['eq', ['account_id', A]]);
    expect(ops).toContainEqual(['eq', ['status', 'completed']]);
    expect(ops).toContainEqual(['eq', ['contact_id', 'c1111111-1111-4111-8111-111111111111']]);
    expect(ops).toContainEqual(['eq', ['reference', 'REF-9']]);
    expect(ops).toContainEqual(['gt', ['created_at', '2026-10-01T00:00:00.000Z']]);
    expect(ops).toContainEqual(['in', ['template_version_id', [`ver-${TPL}`]]]);
    // the template's versions were looked up inside the workspace
    expect(s.opsOf('sign_template_versions')[0]).toEqual(expect.arrayContaining([['eq', ['account_id', A]], ['eq', ['template_id', TPL]]]));
  });

  it('is empty (and asks for no documents) for a template that has no versions in this workspace', async () => {
    const s = stub({ documents: [doc(1)], versions: [] });
    h.client = s.client;
    const body = await json(await listDocuments(call('GET', `/documents?template_id=${TPL_OTHER}`, 'read')));
    expect(body.data).toEqual([]);
    expect(s.opsOf('sign_documents')).toHaveLength(0);
  });

  it('rejects filters that are not valid', async () => {
    h.client = stub({ documents: [] }).client;
    const res = await listDocuments(call('GET', '/documents?status=gone&contact_id=x&template_id=y&created_after=soon&reference=' + 'r'.repeat(65), 'read'));
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error?.issues?.map((i: any) => i.field)).toEqual(['status', 'contact_id', 'template_id', 'reference', 'created_after']);
  });

  it('lists only this workspace through the service too (FakeDb), including drafts', async () => {
    await created({ send: false });
    await createDocument(call('POST', '/documents', 'other', merchantBody({ template_id: TPL_OTHER, reference: 'B-1' })));
    const ctx: SignCtx = { admin: db.client(), accountId: A, userId: null, origin: 'https://halo.test', deps: (await import('@/lib/sign/notify')).realDeps, now: () => new Date() };
    // FakeDb cannot run the keyset or created_after, so only the plain list is asked of it
    const page = await listDocumentsForApi(ctx, { status: null, contactId: null, templateId: null, reference: null, createdAfter: null }, { limit: 50, cursor: null });
    expect(page.documents.map((d) => d.reference)).toEqual(['MERCHANT-1001']);
    expect(page.documents[0].status).toBe('draft');
    expect(page.counts.get(page.documents[0].id)).toEqual({ total: 2, signed: 0 });
  });
});
