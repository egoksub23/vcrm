// ============================================================
// Sending what Doc Sign sends: invitations, reminders, codes, the signed copy and outcomes. Email goes
// out through the platform's Resend sender under the workspace's name; WhatsApp only when the sender
// chose it for a signer, through the workspace's own WhatsApp number and the approved template named in
// Doc Sign settings. Every function returns a result and never throws: a message that could not be
// delivered is something to show and record, not a reason to fail a signature.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadEmailIdentity } from "@/lib/email/identity";
import { isResendConfigured, sendEmail, type EmailAttachment, type EmailIdentity } from "@/lib/email/resend";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";

import { copyEmail, envelopeCopyEmail } from "./copy-messages";
import { codeEmail, completedEmail, declinedEmail, expiredEmail, forwardEmail, forwardNoticeEmail, invitationEmail, reminderEmail, voidedEmail, type Rendered } from "./messages";
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
  emailConfigured: () => boolean;
  sendEmail: typeof sendEmail;
  loadIdentity: (accountId: string) => Promise<EmailIdentity>;
  sendWhatsApp: (admin: SupabaseClient, args: { accountId: string; to: string; templateName: string; language: string; params: string[] }) => Promise<void>;
}

export const realDeps: NotifyDeps = {
  emailConfigured: isResendConfigured,
  sendEmail,
  loadIdentity: loadEmailIdentity,
  sendWhatsApp: sendWhatsAppTemplate,
};

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

async function viaEmail(deps: NotifyDeps, accountId: string, to: string, m: Rendered, identityName: string | null, attachments?: EmailAttachment[]): Promise<Delivery> {
  if (!deps.emailConfigured()) return { channel: "email", status: "not_configured", detail: "RESEND_API_KEY is not set" };
  try {
    const identity = await deps.loadIdentity(accountId);
    await deps.sendEmail({
      to,
      subject: m.subject,
      html: m.html,
      text: m.text,
      fromName: identityName ?? identity.fromName,
      replyTo: identity.replyTo,
      ...(attachments?.length ? { attachments } : {}),
    });
    return { channel: "email", status: "sent" };
  } catch (err) {
    return { channel: "email", status: "failed", detail: err instanceof Error ? err.message.slice(0, 200) : "send failed" };
  }
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
  const attachable = pdf && pdf.bytes.byteLength <= 20 * 1024 * 1024;
  const m = completedEmail({ locale: to.locale, workspace: w.name, name: to.name, title: doc.title, attached: !!attachable, downloadUrl, mode: doc.mode });
  const attachments = attachable ? [{ filename: pdf!.filename, content: Buffer.from(pdf!.bytes).toString("base64") }] : undefined;
  return viaEmail(deps, doc.accountId, to.email, m, displayFrom(w), attachments);
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

/** The files that go on one message: in order, while they fit in `ENVELOPE_ATTACH_BYTES` in all. `fits[i]` says whether file i was attached. */
function attachWithinBudget(pdfs: readonly { bytes: Uint8Array; filename: string }[]): { attached: { filename: string; content: string }[]; fits: boolean[] } {
  let budget = ENVELOPE_ATTACH_BYTES;
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
  const { attached } = attachWithinBudget(pdfs);
  const m = envelopeCompletedEmail({ locale: to.locale, workspace: w.name, name: to.name, title: env.title, count: env.documents.length, attachedCount: attached.length, mode: env.mode });
  return viaEmail(deps, env.accountId, to.email, m, displayFrom(w), attached.length ? attached : undefined);
}

// ---- people who receive a copy (migration 175) ------------------------------------------------------------

/**
 * The signed copy of one document to a person who receives a copy: ONE message, with the sealed PDF attached while it fits (the same limit as
 * the signers' copy). A copy too large to attach is never sent as a download link: the message says the sender can provide it and names the public
 * page that checks a signed document (`verifyUrl`), which shows no document.
 */
export async function deliverCopy(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: { name: string; email: string }, pdf: { bytes: Uint8Array; filename: string } | null, verifyUrl: string): Promise<Delivery> {
  const attachable = !!pdf && pdf.bytes.byteLength <= 20 * 1024 * 1024;
  const m = copyEmail({ locale: doc.locale, workspace: w.name, sender: w.senderName, name: to.name, title: doc.title, attached: attachable, verifyUrl, mode: doc.mode });
  const attachments = attachable ? [{ filename: pdf!.filename, content: Buffer.from(pdf!.bytes).toString("base64") }] : undefined;
  return viaEmail(deps, doc.accountId, to.email, m, displayFrom(w), attachments);
}

/** The signed copies of every document of a collection, in ONE message to a person who receives a copy. Those that do not fit are named with the page that checks them. */
export async function deliverEnvelopeCopy(
  deps: NotifyDeps,
  env: EnvelopeFacts,
  w: Workspace,
  to: { name: string; email: string },
  pdfs: readonly { bytes: Uint8Array; filename: string; title: string; verifyUrl: string }[],
): Promise<Delivery> {
  const { attached, fits } = attachWithinBudget(pdfs);
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
  return viaEmail(deps, env.accountId, to.email, m, displayFrom(w), attached.length ? attached : undefined);
}
