import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isResendConfigured: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('./resend', () => ({
  isResendConfigured: h.isResendConfigured,
  sendEmail: h.sendEmail,
}));

import { sendInvitationEmail } from './invitation-email';

beforeEach(() => {
  h.isResendConfigured.mockReset();
  h.sendEmail.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('sendInvitationEmail', () => {
  it('returns false without calling sendEmail when Resend is not configured', async () => {
    h.isResendConfigured.mockReturnValue(false);
    const sent = await sendInvitationEmail({
      to: 'a@example.com',
      accountName: 'Acme',
      role: 'agent',
      url: 'https://crm.test/join/tok',
      expiresInDays: 7,
    });
    expect(sent).toBe(false);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('sends via Resend and returns true when configured', async () => {
    h.isResendConfigured.mockReturnValue(true);
    h.sendEmail.mockResolvedValue(undefined);

    const sent = await sendInvitationEmail({
      to: 'a@example.com',
      accountName: 'Acme',
      role: 'admin',
      url: 'https://crm.test/join/tok',
      expiresInDays: 1,
    });

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

    await sendInvitationEmail({
      to: 'a@example.com',
      accountName: '<b>Evil</b> & Co',
      role: 'viewer',
      url: 'https://crm.test/join/tok',
      expiresInDays: 7,
    });

    const call = h.sendEmail.mock.calls[0][0];
    expect(call.html).not.toContain('<b>Evil</b>');
    expect(call.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it('propagates a send failure (ResendApiError or otherwise) to the caller', async () => {
    h.isResendConfigured.mockReturnValue(true);
    h.sendEmail.mockRejectedValue(new Error('boom'));

    await expect(
      sendInvitationEmail({
        to: 'a@example.com',
        accountName: 'Acme',
        role: 'agent',
        url: 'https://crm.test/join/tok',
        expiresInDays: 7,
      })
    ).rejects.toThrow('boom');
  });
});
