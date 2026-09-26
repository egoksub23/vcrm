import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock('./resend', () => ({ sendEmail: h.sendEmail }));

import { sendVerificationCodeEmail } from './widget-verification-email';

// vi.resetAllMocks() (not h.sendEmail.mockReset()) — resetting the mock
// instance directly between an already-resolved async test and the next
// one trips a vitest v4 unhandled-rejection false positive; the global
// reset form does not.
beforeEach(() => vi.resetAllMocks());

describe('sendVerificationCodeEmail', () => {
  it('sends the code and widget name in the subject, html and text', async () => {
    h.sendEmail.mockResolvedValue(undefined);

    await sendVerificationCodeEmail({
      to: 'a@example.com',
      code: '042817',
      widgetName: 'Acme Support',
    });

    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const call = h.sendEmail.mock.calls[0][0];
    expect(call.to).toBe('a@example.com');
    expect(call.subject).toContain('042817');
    expect(call.html).toContain('042817');
    expect(call.html).toContain('Acme Support');
    expect(call.text).toContain('042817');
    expect(call.text).toContain('Acme Support');
  });

  it('escapes HTML-unsafe characters in the widget name', async () => {
    h.sendEmail.mockResolvedValue(undefined);

    await sendVerificationCodeEmail({
      to: 'a@example.com',
      code: '111111',
      widgetName: '<b>Evil</b> & Co',
    });

    const call = h.sendEmail.mock.calls[0][0];
    expect(call.html).not.toContain('<b>Evil</b>');
    expect(call.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it('propagates a send failure to the caller', async () => {
    h.sendEmail.mockRejectedValue(new Error('boom'));

    await expect(
      sendVerificationCodeEmail({
        to: 'a@example.com',
        code: '111111',
        widgetName: 'Acme',
      })
    ).rejects.toThrow('boom');
  });
});
