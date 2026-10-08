/**
 * The workspace's connected mailbox, for the mail Halo sends as the workspace (Secure Sign, team invitations, notifications: see workspace-mail.ts).
 * A workspace may have connected a Microsoft 365 mailbox (Settings > Channels > Email), a Gmail mailbox (Settings > Channels > Gmail), or both; there
 * is no "primary email channel" setting, so the order is fixed:
 *
 *   1. a Microsoft 365 mailbox that can send;
 *   2. else a Gmail mailbox that can send;
 *   3. else the mailbox that is connected but cannot send (Microsoft 365 first), reported as a problem, so the answer is "reconnect it", not "set one up";
 *   4. else none.
 *
 * "Can send" means connected, not needing a new sign-in, and not paused (`enabled`, the master switch). Whether the mailbox is also used for the
 * customer care inbox (`inbox_enabled`) plays no part: a mailbox kept only for sending is a usable sender.
 *
 * Throws only when a connection cannot be read at all (the caller treats that as `unavailable`).
 */

import { loadGmailMailbox, realGmailDeps, type GmailSenderDeps } from "./gmail-sender";
import { loadMs365Mailbox, realMs365Deps, type Ms365SenderDeps } from "./ms365-sender";
import type { MailboxOptions, MailboxState } from "./mailbox-types";

export interface MailboxDeps {
  microsoft365: Ms365SenderDeps;
  gmail: GmailSenderDeps;
}

export const realMailboxDeps: MailboxDeps = { microsoft365: realMs365Deps, gmail: realGmailDeps };

export async function loadMailboxState(accountId: string, opts: MailboxOptions = {}, deps: MailboxDeps = realMailboxDeps): Promise<MailboxState> {
  // both are read, so a failure to read one is not hidden by the other being fine: a connection that cannot be read is a problem to report
  const [ms, gmail] = await Promise.allSettled([loadMs365Mailbox(accountId, opts, deps.microsoft365), loadGmailMailbox(accountId, opts, deps.gmail)]);
  const states = [ms, gmail].flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const ready = states.find((s) => s.kind === "ready");
  if (ready) return ready;
  const problem = states.find((s) => s.kind === "problem");
  if (problem) return problem;
  // nothing connected as far as could be read; if a read failed, say that rather than "not set up"
  const failed = [ms, gmail].find((r) => r.status === "rejected");
  if (failed && failed.status === "rejected") throw failed.reason;
  return { kind: "none" };
}
