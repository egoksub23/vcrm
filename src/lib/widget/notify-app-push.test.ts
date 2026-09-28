import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { notifyAppUserOfReplyViaPush } from './notify-app-push';

// A stub that throws on any use — proves the no-op never touches the DB.
const admin = new Proxy(
  {},
  {
    get() {
      throw new Error('notifyAppUserOfReplyViaPush must not touch the admin client yet');
    },
  }
) as SupabaseClient;

describe('notifyAppUserOfReplyViaPush', () => {
  it('resolves without throwing when there is no wallet id', async () => {
    await expect(
      notifyAppUserOfReplyViaPush(admin, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        walletId: null,
      })
    ).resolves.toBeUndefined();
  });

  it('is still a no-op with a wallet id present (no push API wired in yet)', async () => {
    await expect(
      notifyAppUserOfReplyViaPush(admin, {
        accountId: 'acc-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        walletId: 'w-app-123',
      })
    ).resolves.toBeUndefined();
  });
});
