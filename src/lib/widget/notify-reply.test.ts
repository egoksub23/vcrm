import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  isResendConfigured: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/email/resend', () => ({
  isResendConfigured: h.isResendConfigured,
  sendEmail: h.sendEmail,
}));

import { notifyWidgetVisitorOfReply } from './notify-reply';

interface FakeState {
  visitors: { identity_level: string; last_seen_at: string | null }[];
  notification: { notified_at: string } | null;
}
let state: FakeState;
const upserts: Record<string, unknown>[] = [];

function fakeAdmin() {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === 'widget_reply_notifications')
              return { data: state.notification };
            return { data: null };
          },
          // widget_visitors query has no maybeSingle in notify-reply.ts (it expects an array)
          then: (resolve: (v: unknown) => unknown) => {
            if (table === 'widget_visitors')
              return resolve({ data: state.visitors });
            return resolve({ data: null });
          },
        }),
      }),
      upsert: (row: Record<string, unknown>) => {
        upserts.push(row);
        return Promise.resolve({ error: null });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const ARGS = {
  accountId: 'acc-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  contactEmail: 'visitor@example.com',
};

beforeEach(() => {
  h.isResendConfigured.mockReset().mockReturnValue(true);
  h.sendEmail.mockReset().mockResolvedValue(undefined);
  state = { visitors: [], notification: null };
  upserts.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('notifyWidgetVisitorOfReply', () => {
  it('does nothing when there is no contact email', async () => {
    await notifyWidgetVisitorOfReply(fakeAdmin(), {
      ...ARGS,
      contactEmail: null,
    });
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('does nothing when Resend is not configured', async () => {
    h.isResendConfigured.mockReturnValue(false);
    state.visitors = [
      {
        identity_level: 'verified',
        last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    ];
    await notifyWidgetVisitorOfReply(fakeAdmin(), ARGS);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('does nothing when no widget_visitors row is verified (unverified claim, untrusted email)', async () => {
    state.visitors = [
      {
        identity_level: 'claimed',
        last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    ];
    await notifyWidgetVisitorOfReply(fakeAdmin(), ARGS);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('does nothing when the visitor was seen recently (probably still watching live)', async () => {
    state.visitors = [
      {
        identity_level: 'verified',
        last_seen_at: new Date(Date.now() - 30_000).toISOString(),
      },
    ];
    await notifyWidgetVisitorOfReply(fakeAdmin(), ARGS);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('sends an email when verified and away, and records the notification', async () => {
    state.visitors = [
      {
        identity_level: 'verified',
        last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    ];
    await notifyWidgetVisitorOfReply(fakeAdmin(), ARGS);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0][0].to).toBe('visitor@example.com');
    expect(upserts).toEqual([
      expect.objectContaining({
        conversation_id: 'conv-1',
        account_id: 'acc-1',
        notified_at: expect.any(String),
      }),
    ]);
  });

  it('does not re-notify for a second reply in the same away period', async () => {
    const seenAt = Date.now() - 10 * 60_000;
    state.visitors = [
      {
        identity_level: 'verified',
        last_seen_at: new Date(seenAt).toISOString(),
      },
    ];
    // Already notified AFTER the visitor was last seen: still away, already told.
    state.notification = {
      notified_at: new Date(seenAt + 60_000).toISOString(),
    };
    await notifyWidgetVisitorOfReply(fakeAdmin(), ARGS);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('re-notifies once the visitor has been seen again since the last notification', async () => {
    const oldNotifyAt = Date.now() - 60 * 60_000;
    const newSeenAt = Date.now() - 10 * 60_000; // came back, then left again
    state.notification = { notified_at: new Date(oldNotifyAt).toISOString() };
    state.visitors = [
      {
        identity_level: 'verified',
        last_seen_at: new Date(newSeenAt).toISOString(),
      },
    ];
    await notifyWidgetVisitorOfReply(fakeAdmin(), ARGS);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('never throws — a failure is caught and swallowed', async () => {
    h.sendEmail.mockRejectedValue(new Error('boom'));
    state.visitors = [
      {
        identity_level: 'verified',
        last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    ];
    await expect(
      notifyWidgetVisitorOfReply(fakeAdmin(), ARGS)
    ).resolves.toBeUndefined();
  });
});
