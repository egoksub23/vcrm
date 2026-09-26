import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isResendConfigured, ResendApiError, sendEmail } from './resend';

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: 'email-1' }),
  } as Response;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('isResendConfigured', () => {
  it('is false when RESEND_API_KEY is unset', () => {
    delete process.env.RESEND_API_KEY;
    expect(isResendConfigured()).toBe(false);
  });

  it('is false for a blank/whitespace value', () => {
    process.env.RESEND_API_KEY = '   ';
    expect(isResendConfigured()).toBe(false);
  });

  it('is true once a key is set', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    expect(isResendConfigured()).toBe(true);
  });
});

describe('sendEmail', () => {
  it('throws ResendApiError instead of calling fetch when unconfigured', async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendEmail({
        to: 'a@example.com',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
      })
    ).rejects.toThrow(ResendApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the Resend API with the configured sender and bearer key', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.RESEND_FROM_EMAIL = 'invites@example.com';
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail({
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test_key');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      from: 'invites@example.com',
      to: ['a@example.com'],
      subject: 'Hi',
      html: '<p>hi</p>',
      text: 'hi',
    });
  });

  it('falls back to the Resend sandbox sender when RESEND_FROM_EMAIL is unset', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    delete process.env.RESEND_FROM_EMAIL;
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    await sendEmail({
      to: 'a@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.from).toBe('onboarding@resend.dev');
  });

  it('throws ResendApiError with the response status on a non-OK response', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ message: 'invalid `from` address' }),
      } as Response)
    );

    await expect(
      sendEmail({
        to: 'a@example.com',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
      })
    ).rejects.toMatchObject({
      name: 'ResendApiError',
      httpStatus: 422,
      message: 'invalid `from` address',
    });
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      } as unknown as Response)
    );

    await expect(
      sendEmail({
        to: 'a@example.com',
        subject: 's',
        html: '<p>h</p>',
        text: 't',
      })
    ).rejects.toMatchObject({
      httpStatus: 500,
      message: 'Resend request failed: 500',
    });
  });
});
