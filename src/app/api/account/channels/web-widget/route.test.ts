import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  requireCapability: vi.fn(),
  isResendConfigured: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: vi.fn(),
  requireCapability: h.requireCapability,
  toErrorResponse: () =>
    Response.json({ error: 'auth failed' }, { status: 403 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}));
vi.mock('@/lib/email/resend', () => ({
  isResendConfigured: h.isResendConfigured,
}));

import { PUT } from './route';

function ctx() {
  const single = vi.fn(async () => ({
    data: { id: 'cfg-1', verification_mode: 'none' },
    error: null,
  }));
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { id: 'cfg-1', widget_token: 'wt_1' } }),
    update: () => chain,
    single,
  };
  return { supabase: { from: () => chain }, userId: 'u1', accountId: 'a1' };
}

const put = (body: Record<string, unknown>) =>
  PUT(
    new Request('http://localhost/api/account/channels/web-widget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Support', ...body }),
    })
  );

beforeEach(() => {
  h.requireCapability.mockReset().mockResolvedValue(ctx());
  h.isResendConfigured.mockReset().mockReturnValue(false);
});

describe('PUT /api/account/channels/web-widget — verification_mode', () => {
  it('accepts "none" regardless of Resend configuration', async () => {
    expect((await put({ verification_mode: 'none' })).status).toBe(200);
  });

  it('rejects switching to "email_code" when Resend is not configured', async () => {
    const res = await put({ verification_mode: 'email_code' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('bad_request');
    expect(body.error).toMatch(/RESEND_API_KEY/);
  });

  it('accepts "email_code" once Resend is configured', async () => {
    h.isResendConfigured.mockReturnValue(true);
    expect((await put({ verification_mode: 'email_code' })).status).toBe(200);
  });

  it('still rejects the not-yet-implemented "whatsapp_code" mode', async () => {
    h.isResendConfigured.mockReturnValue(true);
    const res = await put({ verification_mode: 'whatsapp_code' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not available yet/i);
  });
});
