/**
 * The browser side of the two switches of a connected mailbox (Settings > Channels > Email / Gmail): one PATCH, and what its answer means for the
 * screen. No Node-only imports: a client component uses it. The server side is app/api/account/channels/email|gmail (route.ts) and
 * lib/ms365|gmail/inbox-switch.ts.
 */

export type MailboxSwitchBody = { enabled: boolean } | { inbox_enabled: boolean };

/** A word the screen can say in the reader's language. */
export type MailboxSwitchRefusal = 'needs_reconnect' | 'start_failed' | 'not_connected' | 'failed';

export type MailboxSwitchOutcome =
  /** `note`: `stop_failed` the provider could not be told to stop its notifications (the inbox is off anyway); `no_push` Gmail push is not set up in this deployment, so nothing will arrive yet. */
  | { ok: true; note: 'none' | 'stop_failed' | 'no_push' }
  | { ok: false; reason: MailboxSwitchRefusal };

export async function patchMailboxSwitch(patchUrl: string, body: MailboxSwitchBody, fetcher: typeof fetch = fetch): Promise<MailboxSwitchOutcome> {
  let res: Response;
  try {
    res = await fetcher(patchUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, reason: 'failed' };
  }
  const data = (await res.json().catch(() => null)) as { code?: string; subscription?: string; watch?: string } | null;
  if (!res.ok) {
    const code = data?.code;
    if (code === 'needs_reconnect') return { ok: false, reason: 'needs_reconnect' };
    if (code === 'subscription_failed' || code === 'watch_failed') return { ok: false, reason: 'start_failed' };
    if (code === 'not_connected') return { ok: false, reason: 'not_connected' };
    return { ok: false, reason: 'failed' };
  }
  if (data?.subscription === 'stop_failed' || data?.watch === 'stop_failed') return { ok: true, note: 'stop_failed' };
  if (data?.watch === 'not_configured') return { ok: true, note: 'no_push' };
  return { ok: true, note: 'none' };
}

/** What the "Send Halo emails from this mailbox" line says: used, or why not. */
export type SendLine = 'used' | 'paused' | 'reconnect';

export function sendLine(mailbox: { status?: string | null; needs_reauth?: boolean | null; enabled?: boolean | null }): SendLine {
  // the same rule as the server's (lib/email/mailbox-types.ts mailboxSendProblem), from the fields the screen keeps current when a switch is flipped
  if (mailbox.needs_reauth === true || (mailbox.status && mailbox.status !== 'connected')) return 'reconnect';
  if (mailbox.enabled === false) return 'paused';
  return 'used';
}
