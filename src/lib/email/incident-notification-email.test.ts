import { afterEach, describe, expect, it, vi } from 'vitest';

import { notifyIncidentEmail, sendIncidentNotificationEmail, type IncidentEmailDeps } from './incident-notification-email';
import type { MailboxState, OutgoingEmail } from './mailbox-types';
import { MailSendError } from './send-reason';
import type { WorkspaceMailDeps } from './workspace-mail';

// An incident email goes out as the recipient's workspace through the shared workspace sender: its connected mailbox when it can send, else the
// platform sender (Resend), else nothing. It never throws and never blocks the raise, the escalation or the cron that wanted it sent.

afterEach(() => vi.restoreAllMocks());

interface Setup {
  state?: MailboxState;
  /** The platform sender is set up (it is one deployment-wide sender, so this is the same for every workspace). */
  mailboxFails?: Error;
}

/** Mail dependencies that answer per workspace: `byAccount[id]` is that workspace's mailbox. */
function world(byAccount: Record<string, Setup>, opts: { resend?: boolean; resendFailsFor?: string } = {}) {
  const sent: { via: 'mailbox' | 'resend'; account: string | null; m: OutgoingEmail }[] = [];
  const deps: WorkspaceMailDeps = {
    emailConfigured: () => opts.resend ?? false,
    sendEmail: async (a) => {
      if (opts.resendFailsFor && a.to === opts.resendFailsFor) throw new Error('refused');
      sent.push({ via: 'resend', account: null, m: a as unknown as OutgoingEmail });
    },
    loadIdentity: async () => ({ fromName: 'Acme' }),
    mailbox: async (account) => {
      const w = byAccount[account] ?? {};
      const state: MailboxState = w.state ?? { kind: 'none' };
      return state.kind === 'ready'
        ? {
            ...state,
            send: async (m: OutgoingEmail) => {
              if (w.mailboxFails) throw w.mailboxFails;
              sent.push({ via: 'mailbox', account, m });
            },
          }
        : state;
    },
  };
  return { sent, deps };
}

const ready: MailboxState = { kind: 'ready', provider: 'gmail', address: 'support@acme.test', attachBytes: 1, send: async () => undefined };
const base = { kind: 'raised' as const, key: 'INC-2026-7', title: 'Outage', severity: 'high', incidentId: 'i1', appBaseUrl: 'https://halo.test/' };

describe('sendIncidentNotificationEmail', () => {
  it('goes through the workspace mailbox when it can send, from the workspace, with a link to the incident', async () => {
    const w = world({ A: { state: ready } }, { resend: true });
    await sendIncidentNotificationEmail({ ...base, to: 'ops@acme.test', accountId: 'A' }, w.deps);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ via: 'mailbox', account: 'A', m: { to: 'ops@acme.test', fromName: 'Acme' } });
    expect(w.sent[0].m.subject).toBe('[high] INC-2026-7 was raised');
    expect(w.sent[0].m.html).toContain('https://halo.test/incidents/i1');
    expect(w.sent[0].m.text).toContain('Open it in Vircle Halo: https://halo.test/incidents/i1');
  });

  it('goes through the platform sender when the workspace has no usable mailbox', async () => {
    const w = world({ A: {} }, { resend: true });
    await sendIncidentNotificationEmail({ ...base, to: 'ops@acme.test', accountId: 'A' }, w.deps);
    expect(w.sent.map((s) => s.via)).toEqual(['resend']);
  });

  it('falls back to the platform sender when the mailbox is paused', async () => {
    const w = world({ A: { state: { kind: 'problem', provider: 'microsoft365', address: 'support@acme.test', problem: 'paused' } } }, { resend: true });
    await sendIncidentNotificationEmail({ ...base, to: 'ops@acme.test', accountId: 'A' }, w.deps);
    expect(w.sent.map((s) => s.via)).toEqual(['resend']);
  });

  it('sends nothing, without a word, when nothing can send', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = world({ A: {} });
    await sendIncidentNotificationEmail({ ...base, to: 'ops@acme.test', accountId: 'A' }, w.deps);
    expect(w.sent).toHaveLength(0);
    expect(err).not.toHaveBeenCalled();
  });

  it('logs and drops a failed send, never throws, and does not try the platform sender after the mailbox failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = world({ A: { state: ready, mailboxFails: new MailSendError('daily_limit', 'quota') } }, { resend: true });
    await expect(sendIncidentNotificationEmail({ ...base, to: 'ops@acme.test', accountId: 'A' }, w.deps)).resolves.toBeUndefined();
    expect(w.sent).toHaveLength(0);
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe('notifyIncidentEmail', () => {
  it('emails each recipient as their own workspace, and skips a person with no address or no workspace', async () => {
    const w = world({ A: { state: ready }, B: {} }, { resend: true });
    const deps: IncidentEmailDeps = {
      mail: w.deps,
      loadRecipients: async () => [
        { email: 'a@acme.test', account_id: 'A' },
        { email: 'b@other.test', account_id: 'B' },
        { email: null, account_id: 'A' },
        { email: 'c@acme.test', account_id: null },
      ],
    };
    await notifyIncidentEmail({ ...base, userIds: ['u1', 'u2', 'u3', 'u4'] }, deps);
    expect(w.sent.map((s) => [s.via, s.m.to]).sort()).toEqual([
      ['mailbox', 'a@acme.test'],
      ['resend', 'b@other.test'],
    ]);
  });

  it('does not even look anyone up for an empty list', async () => {
    let asked = 0;
    const w = world({});
    await notifyIncidentEmail({ ...base, userIds: [] }, { mail: w.deps, loadRecipients: async () => ((asked += 1), []) });
    expect(asked).toBe(0);
  });

  it("never lets one recipient's failure stop the others", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = world({}, { resend: true, resendFailsFor: 'bad@acme.test' });
    const deps: IncidentEmailDeps = {
      mail: w.deps,
      loadRecipients: async () => [
        { email: 'bad@acme.test', account_id: 'A' },
        { email: 'good@acme.test', account_id: 'A' },
      ],
    };
    await expect(notifyIncidentEmail({ ...base, userIds: ['u1', 'u2'] }, deps)).resolves.toBeUndefined();
    expect(w.sent.map((s) => s.m.to)).toEqual(['good@acme.test']);
  });
});
