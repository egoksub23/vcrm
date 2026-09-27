import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isResendConfigured: vi.fn(),
  sendEmail: vi.fn(),
  getValidAccessToken: vi.fn(),
  sendNewMail: vi.fn(),
}));

vi.mock('./resend', () => ({
  isResendConfigured: h.isResendConfigured,
  sendEmail: h.sendEmail,
}));

vi.mock('@/lib/ms365/token', () => ({
  getValidAccessToken: h.getValidAccessToken,
}));

vi.mock('@/lib/ms365/mail-api', () => ({
  sendNewMail: h.sendNewMail,
}));

// Minimal fake matching only the .select().eq().maybeSingle() and
// .update().eq() shapes sendViaConnectedMailbox actually uses.
function fakeAdmin(cfg: Record<string, unknown> | null, updateSpy?: (patch: unknown) => void) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: cfg, error: null }),
        }),
      }),
      update: (patch: unknown) => ({
        eq: async () => {
          updateSpy?.(patch);
          return { data: null, error: null };
        },
      }),
    }),
  };
}

const adminMock = vi.hoisted(() => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/flows/admin-client', () => adminMock);

import { sendInvitationEmail } from './invitation-email';

const baseArgs = {
  to: 'a@example.com',
  accountId: 'acc-1',
  accountName: 'Acme',
  role: 'agent',
  url: 'https://crm.test/join/tok',
  expiresInDays: 7,
};

beforeEach(() => {
  h.isResendConfigured.mockReset();
  h.sendEmail.mockReset();
  h.getValidAccessToken.mockReset();
  h.sendNewMail.mockReset();
  adminMock.supabaseAdmin.mockReset();
  adminMock.supabaseAdmin.mockReturnValue(fakeAdmin(null));
});
afterEach(() => vi.restoreAllMocks());

describe('sendInvitationEmail', () => {
  it('returns false when neither Resend nor a connected mailbox is available', async () => {
    h.isResendConfigured.mockReturnValue(false);
    const sent = await sendInvitationEmail(baseArgs);
    expect(sent).toBe(false);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.sendNewMail).not.toHaveBeenCalled();
  });

  it('sends via Resend and returns true when configured', async () => {
    h.isResendConfigured.mockReturnValue(true);
    h.sendEmail.mockResolvedValue(undefined);

    const sent = await sendInvitationEmail({ ...baseArgs, role: 'admin', expiresInDays: 1 });

    expect(sent).toBe(true);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const call = h.sendEmail.mock.calls[0][0];
    expect(call.to).toBe('a@example.com');
    expect(call.subject).toContain('Acme');
    expect(call.html).toContain('https://crm.test/join/tok');
    expect(call.html).toContain('admin');
    expect(call.text).toContain('https://crm.test/join/tok');
    // Singular "day" wording for expiresInDays === 1.
    expect(call.text).toContain('1 day');
    expect(call.text).not.toContain('1 days');
  });

  it('escapes HTML-unsafe characters in the account name', async () => {
    h.isResendConfigured.mockReturnValue(true);
    h.sendEmail.mockResolvedValue(undefined);

    await sendInvitationEmail({ ...baseArgs, accountName: '<b>Evil</b> & Co', role: 'viewer' });

    const call = h.sendEmail.mock.calls[0][0];
    expect(call.html).not.toContain('<b>Evil</b>');
    expect(call.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it('propagates a send failure (ResendApiError or otherwise) to the caller', async () => {
    h.isResendConfigured.mockReturnValue(true);
    h.sendEmail.mockRejectedValue(new Error('boom'));

    await expect(sendInvitationEmail(baseArgs)).rejects.toThrow('boom');
  });

  describe('without Resend, falling back to a connected Microsoft 365 mailbox', () => {
    beforeEach(() => {
      h.isResendConfigured.mockReturnValue(false);
    });

    it('returns false when no mailbox is connected', async () => {
      adminMock.supabaseAdmin.mockReturnValue(fakeAdmin(null));
      const sent = await sendInvitationEmail(baseArgs);
      expect(sent).toBe(false);
      expect(h.sendNewMail).not.toHaveBeenCalled();
    });

    it('still sends when the mailbox is paused as a customer channel (enabled: false)', async () => {
      // `enabled: false` is the "pause without disconnecting" switch for
      // the customer-facing side (inbound pulling, agent replies) — an
      // admin pausing it specifically to stop that still expects it to
      // keep working for internal sends like this one.
      const cfg = { id: 'cfg-1', enabled: false, needs_reauth: false };
      adminMock.supabaseAdmin.mockReturnValue(fakeAdmin(cfg));
      h.getValidAccessToken.mockResolvedValue('token-abc');
      h.sendNewMail.mockResolvedValue(undefined);

      const sent = await sendInvitationEmail(baseArgs);

      expect(sent).toBe(true);
      expect(h.sendNewMail).toHaveBeenCalledTimes(1);
    });

    it('returns false when the connected mailbox needs reauth', async () => {
      adminMock.supabaseAdmin.mockReturnValue(
        fakeAdmin({ id: 'cfg-1', enabled: true, needs_reauth: true })
      );
      const sent = await sendInvitationEmail(baseArgs);
      expect(sent).toBe(false);
      expect(h.sendNewMail).not.toHaveBeenCalled();
    });

    it('sends via the connected mailbox and returns true when healthy', async () => {
      const cfg = { id: 'cfg-1', enabled: true, needs_reauth: false };
      adminMock.supabaseAdmin.mockReturnValue(fakeAdmin(cfg));
      h.getValidAccessToken.mockResolvedValue('token-abc');
      h.sendNewMail.mockResolvedValue(undefined);

      const sent = await sendInvitationEmail(baseArgs);

      expect(sent).toBe(true);
      expect(h.getValidAccessToken).toHaveBeenCalledWith(cfg);
      expect(h.sendNewMail).toHaveBeenCalledTimes(1);
      const call = h.sendNewMail.mock.calls[0][0];
      expect(call.accessToken).toBe('token-abc');
      expect(call.toAddress).toBe('a@example.com');
      expect(call.html).toContain('https://crm.test/join/tok');
    });

    it('flips needs_reauth and rethrows on a Graph auth error', async () => {
      const { GraphApiError } = await import('@/lib/ms365/errors');
      const updateSpy = vi.fn();
      adminMock.supabaseAdmin.mockReturnValue(
        fakeAdmin({ id: 'cfg-1', enabled: true, needs_reauth: false }, updateSpy)
      );
      h.getValidAccessToken.mockResolvedValue('token-abc');
      h.sendNewMail.mockRejectedValue(new GraphApiError('Token expired', { httpStatus: 401 }));

      await expect(sendInvitationEmail(baseArgs)).rejects.toThrow('Token expired');
      expect(updateSpy).toHaveBeenCalledWith({ needs_reauth: true });
    });
  });
});
