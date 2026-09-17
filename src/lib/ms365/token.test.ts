import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
  encrypt: (v: string) => `enc:${v}`,
}));

const refreshAccessToken = vi.fn();
vi.mock('./oauth', () => ({
  refreshAccessToken: (...args: unknown[]) =>
    (refreshAccessToken as unknown as (...a: unknown[]) => unknown)(...args),
}));

const updateEq = vi.fn(async () => ({ error: null }));
const update = vi.fn(() => ({ eq: updateEq }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ update }) }),
}));

import { getValidAccessToken, type EmailConfigRow } from './token';
import { GraphApiError } from './errors';

function config(overrides: Partial<EmailConfigRow> = {}): EmailConfigRow {
  return {
    id: 'ec-1',
    account_id: 'acct-1',
    access_token: 'enc:old-access',
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refresh_token: 'enc:old-refresh',
    ...overrides,
  };
}

describe('getValidAccessToken', () => {
  beforeEach(() => {
    refreshAccessToken.mockReset();
    update.mockClear();
    updateEq.mockClear();
  });

  it('returns the stored token as-is when far from expiry', async () => {
    const token = await getValidAccessToken(config());
    expect(token).toBe('old-access');
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it('refreshes and persists a new token pair when at/near expiry', async () => {
    refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresInSeconds: 3600,
    });
    const cfg = config({ access_token_expires_at: new Date(Date.now() + 60 * 1000).toISOString() });

    const token = await getValidAccessToken(cfg);

    expect(token).toBe('new-access');
    expect(refreshAccessToken).toHaveBeenCalledWith({ refreshToken: 'old-refresh' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: 'enc:new-access',
        refresh_token: 'enc:new-refresh',
        needs_reauth: false,
      })
    );
    expect(updateEq).toHaveBeenCalledWith('id', 'ec-1');
  });

  it('flips needs_reauth and rethrows on invalid_grant', async () => {
    refreshAccessToken.mockRejectedValueOnce(
      new GraphApiError('refresh token is invalid', { code: 'invalid_grant', httpStatus: 400 })
    );
    const cfg = config({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });

    await expect(getValidAccessToken(cfg)).rejects.toThrow(/invalid/);
    expect(update).toHaveBeenCalledWith({ needs_reauth: true });
    expect(updateEq).toHaveBeenCalledWith('id', 'ec-1');
  });

  it('does not touch needs_reauth for a non-auth refresh failure', async () => {
    refreshAccessToken.mockRejectedValueOnce(new Error('network blip'));
    const cfg = config({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });

    await expect(getValidAccessToken(cfg)).rejects.toThrow('network blip');
    expect(update).not.toHaveBeenCalled();
  });
});
