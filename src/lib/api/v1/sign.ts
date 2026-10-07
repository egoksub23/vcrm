// ============================================================
// Doc Sign in the public API (/api/v1/sign), the parts every route shares: the context a key gets, the
// reading of a request body and of the list filters, the error shape, and the resources the API returns.
//
// What a resource never carries, whatever the route: a signer's link or token, the code a signer was
// sent, an IP address or device, the answers of a form, a storage path, the merge values. The orchestration
// (create and send, remind, files) is in src/lib/sign/service/api.ts.
// ============================================================

import { NextResponse } from 'next/server';

import type { ApiKeyContext } from '@/lib/auth/api-context';
import { bytesForChars, readBodyCapped } from '@/lib/net/read-capped';
import { checkRateLimit } from '@/lib/rate-limit';
import { publicOrigin } from '@/lib/site-url';
import { signEnabled } from '@/lib/sign/feature';
import { realDeps, verifyLink } from '@/lib/sign/notify';
import { MAX_COPY_RECIPIENTS } from '@/lib/sign/envelopes';
import { MAX_SIGNERS, normalizePhone } from '@/lib/sign/rules';
import type { ApiCreateInput, ApiInvitation, ApiProgress, DocumentBundle, ListedDocument, ListFilters } from '@/lib/sign/service/api';
import type { SignCtx } from '@/lib/sign/service/context';
import { SignError } from '@/lib/sign/service/errors';
import type { TemplateRow } from '@/lib/sign/service/templates';
import { StorageError } from '@/lib/sign/storage';
import { DOCUMENT_STATUSES, SIGN_LOCALES, type SignDocumentRow, type SignSignerRow, type SignTemplateVersionRow } from '@/lib/sign/types';

import { rateLimited, toApiErrorResponse } from './respond';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

// ---- the context ----------------------------------------------------------------------------------

/**
 * The Doc Sign context for an authenticated key, or a 403 `sign_disabled` when the operator has Doc Sign
 * off for the workspace (the key's scopes cannot switch the module on). The acting user is whoever made
 * the key (null when they were removed); events carry `via: api_key:<key id>` so the history shows it.
 */
export async function signCtx(request: Request, api: ApiKeyContext): Promise<SignCtx> {
  if (!(await signEnabled(api.supabase, api.accountId))) {
    throw new SignError('sign_disabled', 'Doc Sign is not turned on for this workspace.', 403);
  }
  return {
    admin: api.supabase,
    accountId: api.accountId,
    userId: api.createdBy,
    origin: publicOrigin() || new URL(request.url).origin,
    deps: realDeps,
    now: () => new Date(),
    via: `api_key:${api.keyId}`,
  };
}

/** Calls that send a message to a signer: a tighter budget per key than the general one. */
export function limitSends(api: ApiKeyContext): void {
  const r = checkRateLimit(`sign-api-send:${api.keyId}`, { limit: 30, windowMs: 60_000 });
  if (!r.success) throw rateLimited(r);
}

// ---- errors ----------------------------------------------------------------------------------------

const NO_STORE = { 'Cache-Control': 'no-store' };

/** `{ error: { code, message, issues? } }` for a SignError; the usual envelope for anything else. */
export function signApiError(err: unknown): NextResponse {
  if (err instanceof SignError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) } },
      { status: err.status, headers: NO_STORE },
    );
  }
  if (err instanceof StorageError) {
    console.error('[api/v1/sign] storage error:', err.code);
    return NextResponse.json({ error: { code: 'internal', message: 'Internal server error' } }, { status: 500, headers: NO_STORE });
  }
  return toApiErrorResponse(err);
}

/** A document id that is not a UUID is a document that does not exist. */
export function documentIdOf(id: string): string {
  if (!isUuid(id)) throw new SignError('document_not_found', 'That document was not found.', 404);
  return id;
}

// ---- reading a request ---------------------------------------------------------------------------------

/** A small JSON object body, or a 400 / 413. */
export async function readApiJson(request: Request, maxBytes = 200_000): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SignError('body_too_large', 'That request is too large.', 413);
  // read a piece at a time and stop at the cap (a body sent chunked is not stopped by its declared length)
  const raw = await readBodyCapped(request, bytesForChars(maxBytes));
  if (raw === null) throw new SignError('body_too_large', 'That request is too large.', 413);
  const text = new TextDecoder().decode(raw);
  if (text.length > maxBytes) throw new SignError('body_too_large', 'That request is too large.', 413);
  if (text.trim() === '') return {};
  try {
    const v = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new SignError('bad_json', 'The request body must be a JSON object.', 400);
  }
}

interface Problem {
  field: string;
  detail: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** What a caller may choose as its own reference: printable, no spaces, and never the shape the system numbers with. */
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,63}$/;
const SYSTEM_REFERENCE_RE = /^SGN-\d{4}-\d+$/i;
const MERGE_KEY_RE = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate the body of `POST /documents` strictly: types, sizes and the choices the services accept. Every
 * problem is reported at once, as `issues: [{ code: 'invalid', field, detail }]`. Fields it does not know
 * are ignored, like the other v1 routes. Whether the roles and merge keys fit the template is checked once
 * the template is loaded (service/api.ts).
 */
export function parseCreateBody(body: Record<string, unknown>): ApiCreateInput {
  const problems: Problem[] = [];
  const bad = (field: string, detail: string) => problems.push({ field, detail });

  const optionalString = (field: string, max: number, opts: { min?: number } = {}): string | null => {
    const v = body[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return void bad(field, 'must be a string'), null;
    const t = v.trim();
    if (t === '' && (opts.min ?? 0) === 0) return null;
    if (t.length < (opts.min ?? 0) || t.length > max) return void bad(field, `must be ${opts.min ? `${opts.min} to ` : 'up to '}${max} characters`), null;
    return t;
  };
  const optionalBool = (field: string): boolean | null => {
    const v = body[field];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'boolean') return void bad(field, 'must be true or false'), null;
    return v;
  };

  let templateId = '';
  if (!isUuid(body.template_id)) bad('template_id', 'is required and must be a template id');
  else templateId = body.template_id;

  const reference = optionalString('reference', 64);
  if (reference !== null && (!REFERENCE_RE.test(reference) || SYSTEM_REFERENCE_RE.test(reference))) {
    bad('reference', 'must be 1 to 64 letters, digits or . _ : / # - (no spaces) and not look like SGN-2026-000123');
  }
  const title = optionalString('title', 200);
  let contactId: string | null = null;
  if (body.contact_id !== undefined && body.contact_id !== null) {
    if (isUuid(body.contact_id)) contactId = body.contact_id;
    else bad('contact_id', 'must be a contact id');
  }

  const signers: ApiCreateInput['signers'] = [];
  if (!Array.isArray(body.signers) || body.signers.length === 0) bad('signers', 'is required: a list of one or more people');
  else if (body.signers.length > MAX_SIGNERS) bad('signers', `can have up to ${MAX_SIGNERS} people`);
  else {
    body.signers.forEach((raw, i) => {
      const at = (f: string) => `signers[${i}].${f}`;
      if (!isObject(raw)) return bad(`signers[${i}]`, 'must be an object');
      const roleKey = typeof raw.role_key === 'string' ? raw.role_key.trim() : '';
      if (!roleKey || roleKey.length > 60) bad(at('role_key'), 'is required: the role key from the template');
      const fullName = typeof raw.full_name === 'string' ? raw.full_name.trim() : '';
      if (!fullName || fullName.length > 160) bad(at('full_name'), 'is required, up to 160 characters');
      const email = typeof raw.email === 'string' ? raw.email.trim() : '';
      if (!EMAIL_RE.test(email) || email.length > 254) bad(at('email'), 'must be a valid email address');
      let channel: 'email' | 'whatsapp' = 'email';
      if (raw.channel !== undefined && raw.channel !== null) {
        if (raw.channel === 'email' || raw.channel === 'whatsapp') channel = raw.channel;
        else bad(at('channel'), "must be 'email' or 'whatsapp'");
      }
      let phone: string | null = null;
      if (raw.phone !== undefined && raw.phone !== null && raw.phone !== '') {
        phone = typeof raw.phone === 'string' && raw.phone.length <= 40 ? normalizePhone(raw.phone) : null;
        if (!phone) bad(at('phone'), 'must be an international number such as +60123456789');
      } else if (channel === 'whatsapp') bad(at('phone'), 'is required to send by WhatsApp');
      let orderNo: number | null = null;
      if (raw.order_no !== undefined && raw.order_no !== null) {
        if (Number.isInteger(raw.order_no) && (raw.order_no as number) >= 1 && (raw.order_no as number) <= 1000) orderNo = raw.order_no as number;
        else bad(at('order_no'), 'must be a whole number from 1 to 1000');
      }
      signers.push({ roleKey, fullName, email, phone, channel, orderNo });
    });
  }

  // people who receive the signed copy: a name and an address each, up to 10, not on the signing list and not twice
  const copyTo: ApiCreateInput['copyTo'] = [];
  if (body.copy_to !== undefined && body.copy_to !== null) {
    if (!Array.isArray(body.copy_to)) bad('copy_to', 'must be a list of people: [{ full_name, email }]');
    else if (body.copy_to.length > MAX_COPY_RECIPIENTS) bad('copy_to', `can have up to ${MAX_COPY_RECIPIENTS} people`);
    else {
      const seen = new Set(signers.map((s) => s.email.toLowerCase()));
      body.copy_to.forEach((raw, i) => {
        const at = (f: string) => `copy_to[${i}].${f}`;
        if (!isObject(raw)) return bad(`copy_to[${i}]`, 'must be an object');
        const fullName = typeof raw.full_name === 'string' ? raw.full_name.trim() : '';
        if (!fullName || fullName.length > 160) bad(at('full_name'), 'is required, up to 160 characters');
        const email = typeof raw.email === 'string' ? raw.email.trim() : '';
        if (!EMAIL_RE.test(email) || email.length > 254) bad(at('email'), 'must be a valid email address');
        else if (seen.has(email.toLowerCase())) bad(at('email'), 'is already on the list: a signer already gets the signed copy, and a person is listed once');
        else seen.add(email.toLowerCase());
        copyTo.push({ fullName, email });
      });
    }
  }

  const mergeValues: Record<string, string> = {};
  if (body.merge_values !== undefined && body.merge_values !== null) {
    if (!isObject(body.merge_values)) bad('merge_values', 'must be an object of text values');
    else if (Object.keys(body.merge_values).length > 200) bad('merge_values', 'can have up to 200 values');
    else {
      for (const [k, v] of Object.entries(body.merge_values)) {
        if (!MERGE_KEY_RE.test(k)) bad(`merge_values.${k.slice(0, 60)}`, 'is not a valid key');
        else if (v === null || v === '') continue;
        else if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') bad(`merge_values.${k}`, 'must be text, a number or true/false');
        else if (typeof v === 'number' && !Number.isFinite(v)) bad(`merge_values.${k}`, 'must be a finite number');
        else if (String(v).length > 2000) bad(`merge_values.${k}`, 'must be up to 2000 characters');
        else mergeValues[k] = String(v);
      }
    }
  }

  const message = optionalString('message', 2000);
  let locale: ApiCreateInput['locale'] = null;
  if (body.locale !== undefined && body.locale !== null) {
    if (typeof body.locale === 'string' && (SIGN_LOCALES as readonly string[]).includes(body.locale)) locale = body.locale as ApiCreateInput['locale'];
    else bad('locale', `must be one of ${SIGN_LOCALES.join(', ')}`);
  }
  let expiresInDays: number | null = null;
  if (body.expires_in_days !== undefined && body.expires_in_days !== null) {
    if (Number.isInteger(body.expires_in_days) && (body.expires_in_days as number) >= 1 && (body.expires_in_days as number) <= 365) expiresInDays = body.expires_in_days as number;
    else bad('expires_in_days', 'must be a whole number of days from 1 to 365');
  }
  const signInOrder = optionalBool('sign_in_order');
  const codeRequired = optionalBool('code_required');
  const send = optionalBool('send') ?? true;

  if (problems.length > 0) {
    throw new SignError(
      'bad_request',
      'Some fields are missing or not valid. See `issues`.',
      400,
      problems.map((p) => ({ code: 'invalid', field: p.field, detail: p.detail })),
    );
  }
  return { templateId, reference, title, contactId, signers, copyTo, mergeValues, message, locale, expiresInDays, signInOrder, codeRequired, send };
}

/** `?status`, `?contact_id`, `?template_id`, `?reference`, `?created_after` of the list, or a 400. */
export function parseListFilters(url: URL): ListFilters {
  const problems: Problem[] = [];
  const get = (k: string) => {
    const v = url.searchParams.get(k);
    return v === null || v === '' ? null : v;
  };
  const status = get('status');
  if (status && !(DOCUMENT_STATUSES as readonly string[]).includes(status)) problems.push({ field: 'status', detail: `must be one of ${DOCUMENT_STATUSES.join(', ')}` });
  const contactId = get('contact_id');
  if (contactId && !isUuid(contactId)) problems.push({ field: 'contact_id', detail: 'must be a contact id' });
  const templateId = get('template_id');
  if (templateId && !isUuid(templateId)) problems.push({ field: 'template_id', detail: 'must be a template id' });
  const reference = get('reference');
  if (reference && reference.length > 64) problems.push({ field: 'reference', detail: 'must be up to 64 characters' });
  let createdAfter: string | null = null;
  const after = get('created_after');
  if (after) {
    const t = Date.parse(after);
    if (Number.isNaN(t)) problems.push({ field: 'created_after', detail: 'must be a date or an ISO 8601 time' });
    else createdAfter = new Date(t).toISOString();
  }
  if (problems.length > 0) {
    throw new SignError('bad_request', 'Some filters are not valid. See `issues`.', 400, problems.map((p) => ({ code: 'invalid', field: p.field, detail: p.detail })));
  }
  return { status, contactId, templateId, reference, createdAfter };
}

// ---- resources -------------------------------------------------------------------------------------------

/** A person on a document. No link, token, code, phone, IP address or device. */
export function serializeSigner(s: SignSignerRow) {
  return {
    id: s.id,
    role_key: s.role_key,
    kind: s.kind,
    full_name: s.full_name,
    email: s.email,
    channel: s.channel,
    order_no: s.order_no,
    status: s.status,
    invited_at: s.invited_at,
    viewed_at: s.viewed_at,
    signed_at: s.signed_at,
    declined_at: s.declined_at,
    decline_reason: s.decline_reason,
    last_reminded_at: s.last_reminded_at,
    reminder_count: s.reminder_count,
  };
}

type DocumentFacts = ListedDocument | SignDocumentRow;

/** The facts of a document. `final_sha256` and `verify_url` exist only once it is completed. */
export function serializeDocumentFacts(d: DocumentFacts, templateId: string | null, origin: string) {
  const completed = d.status === 'completed' && !!d.final_sha256;
  return {
    id: d.id,
    reference: d.reference,
    title: d.title,
    status: d.status,
    // 'sign' (an agreement to sign) or 'form' (a form without a signature: people submit; the final file is the sealed submission record)
    mode: d.mode === 'form' ? 'form' : 'sign',
    template_id: templateId,
    contact_id: d.contact_id,
    // read only: the envelope this document is signed in (null for a document on its own); the API does not create or change envelopes
    envelope_id: d.envelope_id ?? null,
    locale: d.locale,
    sign_in_order: d.sign_in_order,
    code_required: d.code_required,
    page_count: d.page_count,
    created_at: d.created_at,
    updated_at: d.updated_at,
    sent_at: d.sent_at,
    expires_at: d.expires_at,
    completed_at: d.completed_at,
    void_reason: d.status === 'voided' ? d.void_reason : null,
    final_sha256: completed ? d.final_sha256 : null,
    verify_url: completed ? verifyLink(origin, d.id) : null,
  };
}

const serializeInvitation = (i: ApiInvitation) => ({ signer_id: i.signerId, role_key: i.roleKey, channel: i.channel, status: i.status });

/** One document with its people, plus `invitations` (what became of each message) and `progress` when given. */
export function serializeBundle(b: DocumentBundle, origin: string, extra: { invitations?: ApiInvitation[]; progress?: ApiProgress[] | null } = {}) {
  return {
    ...serializeDocumentFacts(b.document, b.templateId, origin),
    signers: b.signers.map(serializeSigner),
    // who receives the signed copy: names only (the addresses are the integrator's own; they are not read back)
    copy_to: (b.copies ?? []).map((c) => ({ full_name: c.full_name })),
    ...(extra.invitations ? { invitations: extra.invitations.map(serializeInvitation) } : {}),
    ...(extra.progress !== undefined
      ? {
          progress: extra.progress
            ? extra.progress.map((r) => ({
                role_key: r.roleKey,
                percent: r.percent,
                last_activity_at: r.lastActivityAt,
                parts: r.parts.map((p) => ({ key: p.key, title: p.title, state: p.state, done: p.done, total: p.total })),
              }))
            : null,
        }
      : {}),
  };
}

/** A row of the list: the facts and how many people have signed, without the people. */
export function serializeListed(d: ListedDocument, templateId: string | null, counts: { total: number; signed: number } | undefined, origin: string) {
  return { ...serializeDocumentFacts(d, templateId, origin), signers_total: counts?.total ?? 0, signers_signed: counts?.signed ?? 0 };
}

/** A template as an integrator needs it: the roles to name in `signers` and the merge keys to fill. */
export function serializeTemplate(t: TemplateRow, v: SignTemplateVersionRow) {
  const merge = new Map<string, { key: string; label: string | null; required: boolean }>();
  for (const f of v.fields) {
    if (!f.merge) continue;
    const prev = merge.get(f.merge);
    merge.set(f.merge, { key: f.merge, label: prev?.label ?? f.label ?? null, required: (prev?.required ?? false) || f.required });
  }
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category_id: t.category_id,
    mode: t.mode === 'form' ? 'form' : 'sign',
    version: v.version_no,
    page_count: v.page_count,
    roles: v.roles.map((r) => ({ key: r.key, label: r.label, kind: r.kind })),
    merge_keys: [...merge.values()],
    has_form: !!v.form,
    defaults: {
      expiry_days: v.defaults.expiry_days ?? null,
      sign_in_order: v.defaults.sign_in_order ?? null,
      code_required: v.defaults.code_required ?? null,
      locale: v.defaults.locale ?? null,
    },
  };
}
