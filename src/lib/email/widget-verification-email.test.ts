import { describe, expect, it } from 'vitest';

import type { MailboxState, OutgoingEmail } from './mailbox-types';
import { MailSendError } from './send-reason';
import { sendVerificationCodeEmail } from './widget-verification-email';
import type { WorkspaceMailDeps } from './workspace-mail';

// The widget's verification code is sent as the workspace the widget belongs to, by the shared workspace sender: its connected mailbox when it can
// send, else the platform sender. A failure still propagates (the visitor is waiting for the code).

function world(opts: { state?: MailboxState; resend?: boolean; resendFails?: Error; mailboxFails?: Error } = {}) {
  const resend: OutgoingEmail[] = [];
  const mailbox: OutgoingEmail[] = [];
  const state: MailboxState = opts.state ?? { kind: 'none' };
  const deps: WorkspaceMailDeps = {
    emailConfigured: () => opts.resend ?? true,
    sendEmail: async (a) => {
      if (opts.resendFails) throw opts.resendFails;
      resend.push(a as unknown as OutgoingEmail);
    },
    loadIdentity: async () => ({ fromName: 'Acme Co', replyTo: 'help@acme.test' }),
    mailbox: async () =>
      state.kind === 'ready'
        ? {
            ...state,
            send: async (m) => {
              if (opts.mailboxFails) throw opts.mailboxFails;
              mailbox.push(m);
            },
          }
        : state,
  };
  return { deps, resend, mailbox };
}

const ready: MailboxState = { kind: 'ready', provider: 'microsoft365', address: 'support@acme.test', attachBytes: 1, send: async () => undefined };
const args = { to: 'a@example.com', code: '042817', widgetName: 'Acme Support', accountId: 'acc-1' };

describe('sendVerificationCodeEmail', () => {
  it('sends the code and widget name in the subject, html and text', async () => {
    const w = world();
    await sendVerificationCodeEmail(args, w.deps);
    expect(w.resend).toHaveLength(1);
    const call = w.resend[0];
    expect(call.to).toBe('a@example.com');
    expect(call.subject).toContain('042817');
    expect(call.html).toContain('042817');
    expect(call.html).toContain('Acme Support');
    expect(call.text).toContain('042817');
    expect(call.text).toContain('Acme Support');
    // the workspace's own sender name and reply-to
    expect(call).toMatchObject({ fromName: 'Acme Co', replyTo: 'help@acme.test' });
  });

  it('goes through the workspace mailbox when it can send, in preference to the platform sender', async () => {
    const w = world({ state: ready });
    await sendVerificationCodeEmail(args, w.deps);
    expect(w.mailbox).toHaveLength(1);
    expect(w.resend).toHaveLength(0);
    expect(w.mailbox[0]).toMatchObject({ to: 'a@example.com', fromName: 'Acme Co' });
  });

  it('goes through the platform sender when the mailbox is paused or needs reconnecting', async () => {
    for (const problem of ['paused', 'reconnect'] as const) {
      const w = world({ state: { kind: 'problem', provider: 'gmail', address: 'sales@acme.test', problem } });
      await sendVerificationCodeEmail(args, w.deps);
      expect(w.resend).toHaveLength(1);
    }
  });

  it('sends with the platform sender and no identity when there is no workspace', async () => {
    const w = world({ state: ready });
    await sendVerificationCodeEmail({ ...args, accountId: undefined }, w.deps);
    expect(w.resend).toHaveLength(1);
    expect(w.mailbox).toHaveLength(0);
    expect(w.resend[0]).not.toHaveProperty('fromName');
  });

  it('escapes HTML-unsafe characters in the widget name', async () => {
    const w = world();
    await sendVerificationCodeEmail({ ...args, code: '111111', widgetName: '<b>Evil</b> & Co' }, w.deps);
    expect(w.resend[0].html).not.toContain('<b>Evil</b>');
    expect(w.resend[0].html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it('propagates a send failure to the caller, from the platform sender or the mailbox', async () => {
    await expect(sendVerificationCodeEmail(args, world({ resendFails: new Error('boom') }).deps)).rejects.toThrow('boom');
    await expect(sendVerificationCodeEmail(args, world({ state: ready, mailboxFails: new MailSendError('rate_limited', 'slow down') }).deps)).rejects.toThrow('slow down');
  });

  it('throws when there is no way to send at all', async () => {
    await expect(sendVerificationCodeEmail(args, world({ resend: false }).deps)).rejects.toThrow(/not_set_up|no connected mailbox/);
  });
});
