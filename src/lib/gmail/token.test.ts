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

import { getValidAccessToken, type GmailConfigRow } from './token';
import { GmailApiError } from './errors';

function config(overrides: Partial<GmailConfigRow> = {}): GmailConfigRow {
  return {
    id: 'gc-1',
    account_id: 'acct-1',
    access_token: 'enc:old-access',
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refresh_token: 'enc:old-refresh',
    ...overrides,
  };
}

describe('getValidAccessToken (Gmail)', () => {
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

  it('refreshes and persists a new access token, without touching refresh_token when Google omits one', async () => {
    refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-access',
      expiresInSeconds: 3600,
      // No refreshToken — the ordinary case for Google, unlike Microsoft.
    });
    const cfg = config({ access_token_expires_at: new Date(Date.now() + 60 * 1000).toISOString() });

    const token = await getValidAccessToken(cfg);

    expect(token).toBe('new-access');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'enc:new-access', needs_reauth: false })
    );
    const updateArg = (update.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(updateArg.refresh_token).toBeUndefined();
    expect(updateEq).toHaveBeenCalledWith('id', 'gc-1');
  });

  it('overwrites refresh_token on the occasions Google does return a new one', async () => {
    refreshAccessToken.mockResolvedValueOnce({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresInSeconds: 3600,
    });
    const cfg = config({ access_token_expires_at: new Date(Date.now() + 60 * 1000).toISOString() });

    await getValidAccessToken(cfg);

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: 'enc:new-refresh' }));
  });

  it('flips needs_reauth and rethrows on invalid_grant', async () => {
    refreshAccessToken.mockRejectedValueOnce(
      new GmailApiError('refresh token is invalid', { httpStatus: 400, status: 'invalid_grant' })
    );
    const cfg = config({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });

    await expect(getValidAccessToken(cfg)).rejects.toThrow(/invalid/);
    expect(update).toHaveBeenCalledWith({ needs_reauth: true });
    expect(updateEq).toHaveBeenCalledWith('id', 'gc-1');
  });

  it('does not touch needs_reauth for a non-auth refresh failure', async () => {
    refreshAccessToken.mockRejectedValueOnce(new Error('network blip'));
    const cfg = config({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });

    await expect(getValidAccessToken(cfg)).rejects.toThrow('network blip');
    expect(update).not.toHaveBeenCalled();
  });
});
