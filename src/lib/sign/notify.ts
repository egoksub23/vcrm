// ============================================================
// Sending what Doc Sign sends: invitations, reminders, codes, the signed copy and outcomes. Email goes
// out through the workspace's own connected mailbox (Microsoft 365, else Gmail: Settings > Channels) when it
// has one, from that mailbox's address under the workspace's name; otherwise through the platform's Resend sender;
// otherwise it is not sent and says so. The message itself (words, files, identity) is the same whichever
// way it goes; only the last step differs. WhatsApp only when the sender chose it for a signer, through
// the workspace's own WhatsApp number and the approved template named in Doc Sign settings. Every
// function returns a result and never throws: a message that could not be delivered is something to show
// and record, not a reason to fail a signature.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadEmailIdentity } from "@/lib/email/identity";
import { loadMailboxState } from "@/lib/email/mailbox";
import type { MailboxProblem, MailboxProvider, MailboxState, OutgoingEmail } from "@/lib/email/mailbox-types";
import { isResendConfigured, sendEmail, type EmailAttachment, type EmailIdentity } from "@/lib/email/resend";
import { MailSendError, reasonDetail, type SendReason } from "@/lib/email/send-reason";
import { HALO_SIGN_HEADER, HALO_SIGN_VALUE } from "@/lib/email/halo-mail-marker";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";

import { copyEmail, envelopeCopyEmail } from "./copy-messages";
import { codeEmail, completedEmail, declinedEmail, expiredEmail, forwardEmail, forwardNoticeEmail, invitationEmail, reminderEmail, testEmail, voidedEmail, type Rendered } from "./messages";
import { envelopeCompletedEmail, envelopeInvitationEmail, envelopeReminderEmail } from "./envelope-messages";
import { ENVELOPE_ATTACH_BYTES } from "./envelopes/status";
import { normalizePhone } from "./rules";
import type { Invitation, SignChannel, SignLocale, SignMode, SignSettingsRow } from "./types";

export type DeliveryStatus = "sent" | "failed" | "not_configured";

export interface Delivery {
  channel: SignChannel;
  status: DeliveryStatus;
  detail?: string;
}

export interface NotifyDeps {
  /** The platform sender (Resend) is set up. */
  emailConfigured: () => boolean;
  /** Send through the platform sender. */
  sendEmail: typeof sendEmail;
  loadIdentity: (accountId: string) => Promise<EmailIdentity>;
  sendWhatsApp: (admin: SupabaseClient, args: { accountId: string; to: string; templateName: string; language: string; params: string[] }) => Promise<void>;
  /**
   * The workspace's connected mailbox (Microsoft 365 or Gmail), when it has one: a ready mailbox is used for every email in preference to the platform sender.
   * Absent (as in the tests that predate it), only the platform sender is used.
   */
  mailbox?: (accountId: string) => Promise<MailboxState>;
}

/**
 * What every Doc Sign message sent through a mailbox carries. `X-Halo-Sign` keeps it out of Halo's own inbox ingestion (lib/gmail/ingest-guard.ts,
 * lib/ms365/ingest-guard.ts): the mail holds a person's signing link or a signed document, and the inbox is read by the whole team. Each mailbox sender
 * adds its own "a system sent this, do not auto-reply" header.
 */
export const SIGN_MAIL_HEADERS: Record<string, string> = { [HALO_SIGN_HEADER]: HALO_SIGN_VALUE };

export const realDeps: NotifyDeps = {
  emailConfigured: isResendConfigured,
  sendEmail,
  loadIdentity: loadEmailIdentity,
  sendWhatsApp: sendWhatsAppTemplate,
  mailbox: (accountId) => loadMailboxState(accountId, { headers: SIGN_MAIL_HEADERS }),
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

/**
 * Choose the transport for a workspace: a ready connected mailbox first; else the platform sender when it is set up; else none.
 * Never throws: a mailbox that cannot be read counts as one that cannot send.
 */
export async function chooseEmailTransport(deps: NotifyDeps, accountId: string): Promise<EmailTransport> {
  let problem: MailboxTrouble | null = null;
  if (deps.mailbox) {
    try {
      const state = await deps.mailbox(accountId);
      if (state.kind === "ready") return { via: "mailbox", provider: state.provider, address: state.address, attachBytes: Math.min(state.attachBytes, ENVELOPE_ATTACH_BYTES), send: state.send };
      if (state.kind === "problem") problem = { provider: state.provider, address: state.address, problem: state.problem };
    } catch (err) {
      console.error("[sign] could not read the connected mailbox:", err instanceof Error ? err.message : err);
      problem = { provider: null, address: "", problem: "unavailable" };
    }
  }
  if (deps.emailConfigured()) return { via: "platform", skipped: problem };
  return { via: "none", problem };
}

const PROBLEM_REASON: Record<MailboxProblem, SendReason> = { reconnect: "mailbox_reconnect", paused: "mailbox_paused", unavailable: "service_unavailable" };

/** The delivery to report when no transport can send. */
function undeliverable(t: Extract<EmailTransport, { via: "none" }>): Delivery {
  if (t.problem) return { channel: "email", status: "failed", detail: reasonDetail(PROBLEM_REASON[t.problem.problem], t.problem.address ? `mailbox ${t.problem.address}` : "") };
  return { channel: "email", status: "not_configured", detail: reasonDetail("not_set_up", "no connected mailbox and the platform sender is not set up") };
}

/** What went wrong, as the `detail` of a failed delivery: a named reason when we know it, otherwise the service's own words. */
function failureDetail(err: unknown): string {
  if (err instanceof MailSendError) return err.message;
  return err instanceof Error ? err.message.slice(0, 200) : "send failed";
}

/** The public address of a signer's link. */
export function signerLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/s/${token}`;
}

export function verifyLink(origin: string, documentId: string): string {
  return `${origin.replace(/\/+$/, "")}/verify/${documentId}`;
}

async function sendWhatsAppTemplate(
  admin: SupabaseClient,
  args: { accountId: string; to: string; templateName: string; language: string; params: string[] },
): Promise<void> {
  const { data, error } = await admin.from("whatsapp_config").select("phone_number_id, access_token, enabled").eq("account_id", args.accountId).maybeSingle();
  if (error || !data) throw new Error("whatsapp_not_configured");
  if ((data as { enabled?: boolean }).enabled === false) throw new Error("whatsapp_disabled");
  await sendTemplateMessage({
    phoneNumberId: String((data as { phone_number_id: string }).phone_number_id),
    accessToken: decrypt(String((data as { access_token: string }).access_token)),
    to: args.to,
    templateName: args.templateName,
    language: args.language,
    params: args.params,
  });
}

/** What a message is made of once the transport is known: its words, and the files that fit through it (`attachBytes` is the most those may add up to). */
type MessageBuilder = (attachBytes: number) => { m: Rendered; attachments?: EmailAttachment[] };

/**
 * Send one email by the transport the workspace has. The words, files and identity are built the same for every transport (`build` is told how
 * many bytes of files this transport takes); only the last step differs. Always answers with a Delivery.
 */
async function emailVia(deps: NotifyDeps, accountId: string, to: string, identityName: string | null, build: MessageBuilder): Promise<Delivery> {
  const transport = await chooseEmailTransport(deps, accountId);
  if (transport.via === "none") return undeliverable(transport);
  try {
    const { m, attachments } = build(transport.via === "mailbox" ? transport.attachBytes : ENVELOPE_ATTACH_BYTES);
    const identity = await deps.loadIdentity(accountId);
    const message = {
      to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      fromName: identityName ?? identity.fromName,
      replyTo: identity.replyTo,
      ...(attachments?.length ? { attachments } : {}),
    };
    await (transport.via === "mailbox" ? transport.send(message) : deps.sendEmail(message));
    return { channel: "email", status: "sent" };
  } catch (err) {
    return { channel: "email", status: "failed", detail: failureDetail(err) };
  }
}

/** A message without files of its own. */
function viaEmail(deps: NotifyDeps, accountId: string, to: string, m: Rendered, identityName: string | null): Promise<Delivery> {
  return emailVia(deps, accountId, to, identityName, () => ({ m }));
}

/** One short email to the person who asked for it (Settings > Doc Sign > Email): proves the way email goes out works, sends no document. */
export async function deliverTestEmail(deps: NotifyDeps, accountId: string, to: string, locale: SignLocale, workspace: string, identityName: string | null): Promise<{ delivery: Delivery; via: EmailTransport["via"]; provider: MailboxProvider | null; from: string | null }> {
  const transport = await chooseEmailTransport(deps, accountId);
  const delivery = await viaEmail(deps, accountId, to, testEmail({ locale, workspace }), identityName);
  return { delivery, via: transport.via, provider: transport.via === "mailbox" ? transport.provider : null, from: transport.via === "mailbox" ? transport.address : null };
}

export interface Party {
  name: string;
  email: string;
  phone?: string | null;
  channel: SignChannel;
  locale: SignLocale;
}

export interface DocFacts {
  accountId: string;
  title: string;
  reference: string | null;
  locale: SignLocale;
  expiresAt: Date | null;
  codeRequired: boolean;
  message: string | null;
  /** A form without a signature: every message says "complete your details" and "submitted", never "sign". Absent is an agreement to sign. */
  mode?: SignMode;
}

export interface Workspace {
  name: string;
  /** The person who sent it. */
  senderName: string;
  settings: Pick<SignSettingsRow, "sender_name" | "whatsapp_template_name" | "whatsapp_template_language"> | null;
  timeZone?: string;
}

const displayFrom = (w: Workspace) => w.settings?.sender_name?.trim() || null;

/** Invite someone: by the channel the sender chose. */
export async function deliverInvitation(
  admin: SupabaseClient,
  deps: NotifyDeps,
  origin: string,
  doc: DocFacts,
  w: Workspace,
  inv: Invitation,
  opts: { fill?: boolean } = {},
): Promise<Delivery> {
  const link = signerLink(origin, inv.token);
  if (inv.channel === "whatsapp") {
    const to = normalizePhone(inv.phone);
    const template = w.settings?.whatsapp_template_name;
    if (!to) return { channel: "whatsapp", status: "failed", detail: "no valid phone number" };
    if (!template) return { channel: "whatsapp", status: "not_configured", detail: "no WhatsApp template is set in Doc Sign settings" };
    try {
      await deps.sendWhatsApp(admin, { accountId: doc.accountId, to, templateName: template, language: w.settings?.whatsapp_template_language ?? "en", params: [inv.name, doc.title, link] });
      return { channel: "whatsapp", status: "sent" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "send failed";
      return { channel: "whatsapp", status: msg.startsWith("whatsapp_") ? "not_configured" : "failed", detail: msg.slice(0, 200) };
    }
  }
  const m = invitationEmail({
    locale: doc.locale,
    workspace: w.name,
    sender: w.senderName,
    signerName: inv.name,
    title: doc.title,
    message: doc.message,
    link,
    expiresAt: doc.expiresAt,
    codeRequired: doc.codeRequired,
    fill: opts.fill,
    mode: doc.mode,
    timeZone: w.timeZone,
  });
  return viaEmail(deps, doc.accountId, inv.email, m, displayFrom(w));
}

/**
 * Invite the person a turn, or a part of a form, was forwarded to. Always by email (a forward carries a name and an
 * address only), with the forwarder's name and note. The person gets a link of their own and agrees for themselves.
 */
export async function deliverForward(deps: NotifyDeps, origin: string, doc: DocFacts, w: Workspace, inv: Invitation, opts: { forwarder: string; note?: string | null; part?: string | null }): Promise<Delivery> {
  const m = forwardEmail({
    locale: doc.locale,
    workspace: w.name,
    sender: w.senderName,
    signerName: inv.name,
    title: doc.title,
    link: signerLink(origin, inv.token),
    expiresAt: doc.expiresAt,
    codeRequired: doc.codeRequired,
    mode: doc.mode,
    timeZone: w.timeZone,
    forwarder: opts.forwarder,
    note: opts.note,
    part: opts.part,
  });
  return viaEmail(deps, doc.accountId, inv.email, m, displayFrom(w));
}

/** The sender is told by email that a signer passed their turn on. */
export async function deliverForwardNotice(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: Party, info: { name: string; to: string }): Promise<Delivery> {
  return viaEmail(deps, doc.accountId, to.email, forwardNoticeEmail({ locale: to.locale, workspace: w.name, title: doc.title, name: info.name, to: info.to }), displayFrom(w));
}

/** `partsLeft` (forms): the titles of the parts this person has not finished, named in an email reminder. */
export async function deliverReminder(admin: SupabaseClient, deps: NotifyDeps, origin: string, doc: DocFacts, w: Workspace, inv: Invitation, partsLeft?: string[]): Promise<Delivery> {
  const link = signerLink(origin, inv.token);
  if (inv.channel === "whatsapp") return deliverInvitation(admin, deps, origin, doc, w, inv);
  const m = reminderEmail({ locale: doc.locale, workspace: w.name, sender: w.senderName, signerName: inv.name, title: doc.title, link, expiresAt: doc.expiresAt, codeRequired: doc.codeRequired, mode: doc.mode, timeZone: w.timeZone, partsLeft });
  return viaEmail(deps, doc.accountId, inv.email, m, displayFrom(w));
}

/** The verification code always goes by email, to the address the document was sent to. */
export async function deliverCode(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: string, code: string): Promise<Delivery> {
  return viaEmail(deps, doc.accountId, to, codeEmail({ locale: doc.locale, workspace: w.name, title: doc.title, code }), displayFrom(w));
}

/** The signed copy, to a signer or the sender: attached when it fits, always with a link. */
export async function deliverCompleted(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: Party, pdf: { bytes: Uint8Array; filename: string } | null, downloadUrl?: string): Promise<Delivery> {
  return emailVia(deps, doc.accountId, to.email, displayFrom(w), (limit) => {
    const attachable = !!pdf && pdf.bytes.byteLength <= limit;
    const m = completedEmail({ locale: to.locale, workspace: w.name, name: to.name, title: doc.title, attached: attachable, downloadUrl, mode: doc.mode });
    return { m, attachments: attachable ? [{ filename: pdf!.filename, content: Buffer.from(pdf!.bytes).toString("base64") }] : undefined };
  });
}

export type Outcome = { kind: "declined"; by: string; reason?: string | null } | { kind: "expired" } | { kind: "voided" };

/** Tell someone how a document ended when it did not complete. */
export async function deliverOutcome(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: Party, outcome: Outcome): Promise<Delivery> {
  const m =
    outcome.kind === "declined"
      ? declinedEmail({ locale: to.locale, workspace: w.name, name: outcome.by, title: doc.title, reason: outcome.reason, mode: doc.mode })
      : outcome.kind === "expired"
        ? expiredEmail({ locale: to.locale, workspace: w.name, title: doc.title, mode: doc.mode })
        : voidedEmail({ locale: to.locale, workspace: w.name, title: doc.title });
  return viaEmail(deps, doc.accountId, to.email, m, displayFrom(w));
}

// ---- envelopes (migration 171) -----------------------------------------------------------------------
// One invitation, one reminder and one completion message for each person of an envelope, whatever the number of documents.

/** What an envelope's messages say: its own title, language, expiry, code and note, and the titles of its documents in order. */
export interface EnvelopeFacts {
  accountId: string;
  title: string;
  reference: string | null;
  locale: SignLocale;
  expiresAt: Date | null;
  codeRequired: boolean;
  message: string | null;
  /** Every document is a form without a signature. */
  mode?: SignMode;
  documents: string[];
}

/** Invite a person of an envelope: by the channel the sender chose, with ONE link that opens every document of theirs. */
export async function deliverEnvelopeInvitation(admin: SupabaseClient, deps: NotifyDeps, origin: string, env: EnvelopeFacts, w: Workspace, inv: Invitation, opts: { fill?: boolean } = {}): Promise<Delivery> {
  const link = signerLink(origin, inv.token);
  if (inv.channel === "whatsapp") {
    const to = normalizePhone(inv.phone);
    const template = w.settings?.whatsapp_template_name;
    if (!to) return { channel: "whatsapp", status: "failed", detail: "no valid phone number" };
    if (!template) return { channel: "whatsapp", status: "not_configured", detail: "no WhatsApp template is set in Doc Sign settings" };
    try {
      await deps.sendWhatsApp(admin, { accountId: env.accountId, to, templateName: template, language: w.settings?.whatsapp_template_language ?? "en", params: [inv.name, env.title, link] });
      return { channel: "whatsapp", status: "sent" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "send failed";
      return { channel: "whatsapp", status: msg.startsWith("whatsapp_") ? "not_configured" : "failed", detail: msg.slice(0, 200) };
    }
  }
  const m = envelopeInvitationEmail({
    locale: env.locale,
    workspace: w.name,
    sender: w.senderName,
    signerName: inv.name,
    title: env.title,
    documents: env.documents,
    message: env.message,
    link,
    expiresAt: env.expiresAt,
    codeRequired: env.codeRequired,
    fill: opts.fill ?? env.mode === "form",
    timeZone: w.timeZone,
  });
  return viaEmail(deps, env.accountId, inv.email, m, displayFrom(w));
}

/** A reminder for a person of an envelope; `env.documents` are the titles of what they have not finished. The earlier link no longer works. */
export async function deliverEnvelopeReminder(admin: SupabaseClient, deps: NotifyDeps, origin: string, env: EnvelopeFacts, w: Workspace, inv: Invitation): Promise<Delivery> {
  if (inv.channel === "whatsapp") return deliverEnvelopeInvitation(admin, deps, origin, env, w, inv);
  const m = envelopeReminderEmail({
    locale: env.locale,
    workspace: w.name,
    sender: w.senderName,
    signerName: inv.name,
    title: env.title,
    documents: env.documents,
    link: signerLink(origin, inv.token),
    expiresAt: env.expiresAt,
    codeRequired: env.codeRequired,
    fill: env.mode === "form",
    timeZone: w.timeZone,
  });
  return viaEmail(deps, env.accountId, inv.email, m, displayFrom(w));
}

/** The files that go on one message: in order, while they fit in `limit` bytes in all (`ENVELOPE_ATTACH_BYTES`, or less through a mailbox). `fits[i]` says whether file i was attached. */
function attachWithinBudget(pdfs: readonly { bytes: Uint8Array; filename: string }[], limit: number = ENVELOPE_ATTACH_BYTES): { attached: { filename: string; content: string }[]; fits: boolean[] } {
  let budget = limit;
  const attached: { filename: string; content: string }[] = [];
  const fits: boolean[] = [];
  for (const f of pdfs) {
    if (f.bytes.byteLength > budget) {
      fits.push(false);
      continue;
    }
    budget -= f.bytes.byteLength;
    attached.push({ filename: f.filename, content: Buffer.from(f.bytes).toString("base64") });
    fits.push(true);
  }
  return { attached, fits };
}

/**
 * The signed copies of every document, in ONE message to a person or the sender. The files are attached in the envelope's order while
 * they fit in ENVELOPE_ATTACH_BYTES in all; the message says how many were attached and sends the rest to the person's own link.
 */
export async function deliverEnvelopeCompleted(deps: NotifyDeps, env: EnvelopeFacts, w: Workspace, to: Party, pdfs: readonly { bytes: Uint8Array; filename: string }[]): Promise<Delivery> {
  return emailVia(deps, env.accountId, to.email, displayFrom(w), (limit) => {
    const { attached } = attachWithinBudget(pdfs, limit);
    const m = envelopeCompletedEmail({ locale: to.locale, workspace: w.name, name: to.name, title: env.title, count: env.documents.length, attachedCount: attached.length, mode: env.mode });
    return { m, attachments: attached.length ? attached : undefined };
  });
}

// ---- people who receive a copy (migration 175) ------------------------------------------------------------

/**
 * The signed copy of one document to a person who receives a copy: ONE message, with the sealed PDF attached while it fits (the same limit as
 * the signers' copy). A copy too large to attach is never sent as a download link: the message says the sender can provide it and names the public
 * page that checks a signed document (`verifyUrl`), which shows no document.
 */
export async function deliverCopy(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: { name: string; email: string }, pdf: { bytes: Uint8Array; filename: string } | null, verifyUrl: string): Promise<Delivery> {
  return emailVia(deps, doc.accountId, to.email, displayFrom(w), (limit) => {
    const attachable = !!pdf && pdf.bytes.byteLength <= limit;
    const m = copyEmail({ locale: doc.locale, workspace: w.name, sender: w.senderName, name: to.name, title: doc.title, attached: attachable, verifyUrl, mode: doc.mode });
    return { m, attachments: attachable ? [{ filename: pdf!.filename, content: Buffer.from(pdf!.bytes).toString("base64") }] : undefined };
  });
}

/** The signed copies of every document of a collection, in ONE message to a person who receives a copy. Those that do not fit are named with the page that checks them. */
export async function deliverEnvelopeCopy(
  deps: NotifyDeps,
  env: EnvelopeFacts,
  w: Workspace,
  to: { name: string; email: string },
  pdfs: readonly { bytes: Uint8Array; filename: string; title: string; verifyUrl: string }[],
): Promise<Delivery> {
  return emailVia(deps, env.accountId, to.email, displayFrom(w), (limit) => {
    const { attached, fits } = attachWithinBudget(pdfs, limit);
    const m = envelopeCopyEmail({
      locale: env.locale,
      workspace: w.name,
      sender: w.senderName,
      name: to.name,
      title: env.title,
      count: env.documents.length,
      attachedCount: attached.length,
      notAttached: pdfs.filter((_, i) => !fits[i]).map((f) => ({ title: f.title, verifyUrl: f.verifyUrl })),
      mode: env.mode,
    });
    return { m, attachments: attached.length ? attached : undefined };
  });
}
