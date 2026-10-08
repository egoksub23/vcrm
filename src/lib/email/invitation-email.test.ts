import { describe, expect, it } from 'vitest';

import type { MailboxState, OutgoingEmail } from './mailbox-types';
import { MailSendError } from './send-reason';
import { sendInvitationEmail } from './invitation-email';
import type { WorkspaceMailDeps } from './workspace-mail';

// A team invitation is mail of the workspace: it goes through the shared workspace sender, so through the workspace's own connected mailbox when that
// can send (whatever its customer-care-inbox switch says), else the platform sender (Resend), else not at all. The very first invitation, from a
// workspace with no mailbox yet, still goes by Resend.

interface World {
  deps: WorkspaceMailDeps;
  resend: OutgoingEmail[];
  mailbox: OutgoingEmail[];
}

function world(opts: { state?: MailboxState; resend?: boolean; resendFails?: Error; mailboxFails?: Error } = {}): World {
  const resend: OutgoingEmail[] = [];
  const mailbox: OutgoingEmail[] = [];
  const state: MailboxState = opts.state ?? { kind: 'none' };
  const live: MailboxState =
    state.kind === 'ready'
      ? {
          ...state,
          send: async (m) => {
            if (opts.mailboxFails) throw opts.mailboxFails;
            mailbox.push(m);
          },
        }
      : state;
  const deps: WorkspaceMailDeps = {
    emailConfigured: () => opts.resend ?? false,
    sendEmail: async (a) => {
      if (opts.resendFails) throw opts.resendFails;
      resend.push(a as unknown as OutgoingEmail);
    },
    loadIdentity: async () => ({ fromName: 'Acme', replyTo: 'help@acme.test' }),
    mailbox: async () => live,
  };
  return { deps, resend, mailbox };
}

const ready: MailboxState = { kind: 'ready', provider: 'microsoft365', address: 'support@acme.test', attachBytes: 1, send: async () => undefined };

const baseArgs = {
  to: 'a@example.com',
  accountId: 'acc-1',
  accountName: 'Acme',
  role: 'agent',
  url: 'https://crm.test/join/tok',
  expiresInDays: 7,
};

describe('sendInvitationEmail', () => {
  it('returns false when neither a mailbox nor the platform sender is available', async () => {
    const w = world();
    expect(await sendInvitationEmail(baseArgs, w.deps)).toBe(false);
    expect(w.resend).toHaveLength(0);
    expect(w.mailbox).toHaveLength(0);
  });

  it('sends via the platform sender (Resend) and returns true when the workspace has no mailbox: the first invitation of a new workspace', async () => {
    const w = world({ resend: true });
    expect(await sendInvitationEmail({ ...baseArgs, role: 'admin', expiresInDays: 1 }, w.deps)).toBe(true);
    expect(w.resend).toHaveLength(1);
    const call = w.resend[0];
    expect(call.to).toBe('a@example.com');
    expect(call.subject).toContain('Acme');
    expect(call.html).toContain('https://crm.test/join/tok');
    expect(call.html).toContain('admin');
    expect(call.text).toContain('https://crm.test/join/tok');
    // Singular "day" wording for expiresInDays === 1.
    expect(call.text).toContain('1 day');
    expect(call.text).not.toContain('1 days');
    // the workspace's name and reply-to, as before
    expect(call).toMatchObject({ fromName: 'Acme', replyTo: 'help@acme.test' });
  });

  it('escapes HTML-unsafe characters in the account name', async () => {
    const w = world({ resend: true });
    await sendInvitationEmail({ ...baseArgs, accountName: '<b>Evil</b> & Co', role: 'viewer' }, w.deps);
    expect(w.resend[0].html).not.toContain('<b>Evil</b>');
    expect(w.resend[0].html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it('propagates a send failure (ResendApiError or otherwise) to the caller', async () => {
    const w = world({ resend: true, resendFails: new Error('boom') });
    await expect(sendInvitationEmail(baseArgs, w.deps)).rejects.toThrow('boom');
  });

  describe('with a connected mailbox', () => {
    it('sends through the mailbox in preference to the platform sender, and returns true', async () => {
      const w = world({ state: ready, resend: true });
      expect(await sendInvitationEmail(baseArgs, w.deps)).toBe(true);
      expect(w.mailbox).toHaveLength(1);
      expect(w.resend).toHaveLength(0);
      expect(w.mailbox[0]).toMatchObject({ to: 'a@example.com', fromName: 'Acme', replyTo: 'help@acme.test' });
      expect(w.mailbox[0].html).toContain('https://crm.test/join/tok');
    });

    it('sends through the mailbox when there is no platform sender at all', async () => {
      const w = world({ state: ready, resend: false });
      expect(await sendInvitationEmail(baseArgs, w.deps)).toBe(true);
      expect(w.mailbox).toHaveLength(1);
    });

    it('falls back to the platform sender when the mailbox is paused or needs reconnecting', async () => {
      for (const problem of ['paused', 'reconnect'] as const) {
        const w = world({ state: { kind: 'problem', provider: 'microsoft365', address: 'support@acme.test', problem }, resend: true });
        expect(await sendInvitationEmail(baseArgs, w.deps)).toBe(true);
        expect(w.resend).toHaveLength(1);
        expect(w.mailbox).toHaveLength(0);
      }
    });

    it('returns false (share the link yourself) when the mailbox cannot send and there is no platform sender', async () => {
      for (const problem of ['paused', 'reconnect', 'unavailable'] as const) {
        const w = world({ state: { kind: 'problem', provider: 'gmail', address: 'sales@acme.test', problem } });
        expect(await sendInvitationEmail(baseArgs, w.deps)).toBe(false);
      }
    });

    it('throws what the mail service said when the mailbox accepted the job and the send failed', async () => {
      const w = world({ state: ready, resend: true, mailboxFails: new MailSendError('rate_limited', 'Too many requests') });
      await expect(sendInvitationEmail(baseArgs, w.deps)).rejects.toThrow('Too many requests');
      expect(w.resend).toHaveLength(0);
    });
  });
});
