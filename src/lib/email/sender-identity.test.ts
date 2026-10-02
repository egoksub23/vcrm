import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveEmailIdentity } from './identity';
import { formatFrom, safeReplyTo, sendEmail } from './resend';

describe('formatFrom', () => {
  it('puts the workspace name in front of the deployment address', () => {
    expect(formatFrom('invites@crm.example.com', 'Acme Support')).toBe('Acme Support <invites@crm.example.com>');
  });

  it('keeps only the address of a configured "Name <addr>"', () => {
    expect(formatFrom('Vircle Halo <invites@crm.example.com>', 'Acme Support')).toBe('Acme Support <invites@crm.example.com>');
  });

  it('leaves the configured sender untouched with no workspace name', () => {
    expect(formatFrom('Vircle Halo <invites@crm.example.com>', null)).toBe('Vircle Halo <invites@crm.example.com>');
    expect(formatFrom('invites@crm.example.com', '   ')).toBe('invites@crm.example.com');
  });

  it('can never change the address or add a header through the name', () => {
    const out = formatFrom('invites@crm.example.com', 'Evil" <attacker@x.test>\r\nBcc: v@x.test');
    expect(out.endsWith('<invites@crm.example.com>')).toBe(true);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out.match(/</g)).toHaveLength(1);
    expect(out).not.toContain('attacker@x.test>');
  });

  it('caps the name length and keeps non-Latin names', () => {
    expect(formatFrom('a@b.co', 'x'.repeat(100))).toBe(`${'x'.repeat(60)} <a@b.co>`);
    expect(formatFrom('a@b.co', '고객 지원')).toBe('고객 지원 <a@b.co>');
  });
});

describe('safeReplyTo', () => {
  it('accepts one plain address and trims it', () => {
    expect(safeReplyTo(' help@acme.example ')).toBe('help@acme.example');
  });
  it.each(['', '   ', 'nope', 'a@b', 'a@b.co, c@d.co', '<a@b.co>', 'a@b.co\nBcc: x@y.z', null, undefined])(
    'refuses %j',
    (v) => {
      expect(safeReplyTo(v as string | null | undefined)).toBeUndefined();
    },
  );
});

describe('resolveEmailIdentity', () => {
  it('prefers the sender name, then the product name, then the company name', () => {
    expect(resolveEmailIdentity({ name: 'Acme Ltd', brand_name: 'Acme Desk', email_sender_name: 'Acme Support' }).fromName).toBe('Acme Support');
    expect(resolveEmailIdentity({ name: 'Acme Ltd', brand_name: 'Acme Desk', email_sender_name: null }).fromName).toBe('Acme Desk');
    expect(resolveEmailIdentity({ name: 'Acme Ltd', brand_name: ' ', email_sender_name: '' }).fromName).toBe('Acme Ltd');
  });
  it('carries the reply-to, or null', () => {
    expect(resolveEmailIdentity({ name: 'A', email_reply_to: 'help@acme.example' }).replyTo).toBe('help@acme.example');
    expect(resolveEmailIdentity({ name: 'A' }).replyTo).toBeNull();
  });
  it('is empty with no row', () => {
    expect(resolveEmailIdentity(null)).toEqual({});
  });
});

describe('sendEmail with a workspace identity', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env = { ...env, RESEND_API_KEY: 're_test', RESEND_FROM_EMAIL: 'invites@crm.example.com' };
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it('sends under the workspace name with its reply-to', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await sendEmail({ to: 'x@y.co', subject: 's', html: 'h', text: 't', fromName: 'Acme Support', replyTo: 'help@acme.example' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.from).toBe('Acme Support <invites@crm.example.com>');
    expect(body.reply_to).toBe('help@acme.example');
  });

  it('sends as the platform, with no reply_to, when no identity is given', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await sendEmail({ to: 'x@y.co', subject: 's', html: 'h', text: 't' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.from).toBe('invites@crm.example.com');
    expect('reply_to' in body).toBe(false);
  });

  it('drops a reply-to that is not a plain address', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await sendEmail({ to: 'x@y.co', subject: 's', html: 'h', text: 't', replyTo: 'a@b.co, evil@x.test' });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect('reply_to' in body).toBe(false);
  });
});
