/**
 * The ONE way Halo sends an email as a workspace: team invitations, notifications, verification codes, Secure Sign's messages. Whatever the message
 * is, the way it goes out is chosen the same way:
 *
 *   1. the workspace's connected mailbox, from that mailbox's address under the workspace's name (Microsoft 365 first, then Gmail: mailbox.ts), when it
 *      is connected, does not need reconnecting and is not paused. Whether the mailbox is also used for the customer care inbox has no say in this;
 *   2. else the platform sender (Resend), when it is set up;
 *   3. else not at all, and it says so.
 *
 * Every message a mailbox sends carries `X-Halo-System: 1` (the senders add it), so the Inbox ingestion never reads it back as a customer's message.
 *
 * `sendWorkspaceEmail` always answers with a result and never throws: a message that could not be delivered is something to show or log, not a reason
 * to fail the work that wanted to send it. Callers that must tell "no way to send" from "tried and failed" read `via` and `status`.
 *
 * Platform-level mail (a new customer's welcome, operator notices: anything with no workspace, or sent before a workspace has a mailbox) does not come
 * through here; it uses the platform sender directly.
 *
 * Every dependency is injectable, so the choice and the send are tested without Microsoft, Google or Resend.
 */

import { loadEmailIdentity } from "./identity";
import { loadMailboxState } from "./mailbox";
import type { MailboxProblem, MailboxProvider, MailboxState, OutgoingEmail } from "./mailbox-types";
import { isResendConfigured, sendEmail, type EmailAttachment, type EmailIdentity } from "./resend";
import { MailSendError, reasonDetail, type SendReason } from "./send-reason";

export interface WorkspaceMailDeps {
  /** The platform sender (Resend) is set up. */
  emailConfigured: () => boolean;
  /** Send through the platform sender. */
  sendEmail: typeof sendEmail;
  loadIdentity: (accountId: string) => Promise<EmailIdentity>;
  /**
   * The workspace's connected mailbox (Microsoft 365 or Gmail), when it has one: a ready mailbox is used for every email in preference to the platform
   * sender. Absent, only the platform sender is used.
   */
  mailbox?: (accountId: string) => Promise<MailboxState>;
}

export const realWorkspaceMailDeps: WorkspaceMailDeps = {
  emailConfigured: isResendConfigured,
  sendEmail,
  loadIdentity: loadEmailIdentity,
  mailbox: (accountId) => loadMailboxState(accountId),
};

// ---- which way email goes -----------------------------------------------------------------------------------

/** How a workspace's email goes out: through its connected mailbox, through the platform sender, or not at all. */
export type EmailTransport =
  | { via: "mailbox"; provider: MailboxProvider; address: string; attachBytes: number; send: (m: OutgoingEmail) => Promise<void> }
  /** `skipped`: a mailbox is connected but could not be used, so the platform sender took its place. */
  | { via: "platform"; skipped: MailboxTrouble | null }
  /** Nothing can send. `problem` is set when a mailbox is connected but cannot send (so the answer is "reconnect it", not "set one up"). */
  | { via: "none"; problem: MailboxTrouble | null };

/** A connected mailbox that cannot send. `provider` is null when the connection could not be read at all. */
export interface MailboxTrouble {
  provider: MailboxProvider | null;
  address: string;
  problem: MailboxProblem;
}

export interface TransportOptions {
  /** The most the files on one message may add up to, whatever the transport allows (a feature's own limit). Default: what the transport allows. */
  attachCap?: number;
}

/**
 * Choose the transport for a workspace: a ready connected mailbox first; else the platform sender when it is set up; else none.
 * Never throws: a mailbox that cannot be read counts as one that cannot send.
 */
export async function chooseEmailTransport(deps: Pick<WorkspaceMailDeps, "mailbox" | "emailConfigured">, accountId: string, opts: TransportOptions = {}): Promise<EmailTransport> {
  let problem: MailboxTrouble | null = null;
  if (deps.mailbox) {
    try {
      const state = await deps.mailbox(accountId);
      if (state.kind === "ready") return { via: "mailbox", provider: state.provider, address: state.address, attachBytes: Math.min(state.attachBytes, opts.attachCap ?? Infinity), send: state.send };
      if (state.kind === "problem") problem = { provider: state.provider, address: state.address, problem: state.problem };
    } catch (err) {
      console.error("[workspace-mail] could not read the connected mailbox:", err instanceof Error ? err.message : err);
      problem = { provider: null, address: "", problem: "unavailable" };
    }
  }
  if (deps.emailConfigured()) return { via: "platform", skipped: problem };
  return { via: "none", problem };
}

/** Whether some way of sending exists at all (a usable mailbox or the platform sender): for callers that check before they spend work on a message. */
export async function canSendWorkspaceEmail(accountId: string, deps: Pick<WorkspaceMailDeps, "mailbox" | "emailConfigured"> = realWorkspaceMailDeps): Promise<boolean> {
  return (await chooseEmailTransport(deps, accountId)).via !== "none";
}

// ---- sending ------------------------------------------------------------------------------------------------

/** One message. The words, files and addressing are the caller's; the sender name and reply-to default to the workspace's. */
export interface WorkspaceEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
  /** Overrides the workspace's sender name. */
  fromName?: string | null;
  /** Overrides the workspace's reply-to. */
  replyTo?: string | null;
}

/** A message that depends on the transport (how many bytes of files fit through it): built once the way it goes is known. */
export type WorkspaceEmailBuilder = (limits: { attachBytes: number }) => WorkspaceEmail;

export interface WorkspaceMailResult {
  /** `sent`: handed to the mail service. `failed`: a way to send existed and the send did not work, or a connected mailbox cannot send and nothing else can. `not_configured`: there is no way to send. */
  status: "sent" | "failed" | "not_configured";
  /** The way it went, or `none` when there was none. */
  via: EmailTransport["via"];
  /** Which kind of mailbox it went through, or the one that cannot send. */
  provider: MailboxProvider | null;
  /** The mailbox address it was sent from (only when it went through a mailbox). */
  from: string | null;
  /** On a failure: a named reason ("mailbox_reconnect: ...") when we know it, otherwise the service's own words. */
  detail?: string;
}

const PROBLEM_REASON: Record<MailboxProblem, SendReason> = { reconnect: "mailbox_reconnect", paused: "mailbox_paused", unavailable: "service_unavailable" };

/** What went wrong, as the `detail` of a failed result: a named reason when we know it, otherwise the service's own words. */
export function failureDetail(err: unknown): string {
  if (err instanceof MailSendError) return err.message;
  return err instanceof Error ? err.message.slice(0, 200) : "send failed";
}

/** The result to report when no transport can send. */
function undeliverable(t: Extract<EmailTransport, { via: "none" }>): WorkspaceMailResult {
  if (t.problem) {
    return {
      status: "failed",
      via: "none",
      provider: t.problem.provider,
      from: null,
      detail: reasonDetail(PROBLEM_REASON[t.problem.problem], t.problem.address ? `mailbox ${t.problem.address}` : ""),
    };
  }
  return { status: "not_configured", via: "none", provider: null, from: null, detail: reasonDetail("not_set_up", "no connected mailbox and the platform sender is not set up") };
}

/**
 * Send one email as the workspace by the way it has (see the top of this file). `mail` is the message, or a function that builds it once the way is
 * known (so a feature can fit its files to what the transport takes). Never throws.
 */
export async function sendWorkspaceEmail(
  accountId: string,
  mail: WorkspaceEmail | WorkspaceEmailBuilder,
  deps: WorkspaceMailDeps = realWorkspaceMailDeps,
  opts: TransportOptions & { fromName?: string | null } = {},
): Promise<WorkspaceMailResult> {
  const transport = await chooseEmailTransport(deps, accountId, opts);
  if (transport.via === "none") return undeliverable(transport);
  const where = {
    via: transport.via,
    provider: transport.via === "mailbox" ? transport.provider : null,
    from: transport.via === "mailbox" ? transport.address : null,
  };
  try {
    const m = typeof mail === "function" ? mail({ attachBytes: transport.via === "mailbox" ? transport.attachBytes : (opts.attachCap ?? Infinity) }) : mail;
    const identity = await deps.loadIdentity(accountId);
    const message: OutgoingEmail = {
      to: m.to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      fromName: opts.fromName ?? m.fromName ?? identity.fromName,
      replyTo: m.replyTo ?? identity.replyTo,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    };
    await (transport.via === "mailbox" ? transport.send(message) : deps.sendEmail(message));
    return { status: "sent", ...where };
  } catch (err) {
    return { status: "failed", ...where, detail: failureDetail(err) };
  }
}
