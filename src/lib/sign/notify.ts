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

import { codeEmail, completedEmail, declinedEmail, expiredEmail, invitationEmail, reminderEmail, voidedEmail, type Rendered } from "./messages";
import { normalizePhone } from "./rules";
import type { Invitation, SignChannel, SignLocale, SignSettingsRow } from "./types";

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
    timeZone: w.timeZone,
  });
  return viaEmail(deps, doc.accountId, inv.email, m, displayFrom(w));
}

export async function deliverReminder(admin: SupabaseClient, deps: NotifyDeps, origin: string, doc: DocFacts, w: Workspace, inv: Invitation): Promise<Delivery> {
  const link = signerLink(origin, inv.token);
  if (inv.channel === "whatsapp") return deliverInvitation(admin, deps, origin, doc, w, inv);
  const m = reminderEmail({ locale: doc.locale, workspace: w.name, sender: w.senderName, signerName: inv.name, title: doc.title, link, expiresAt: doc.expiresAt, codeRequired: doc.codeRequired, timeZone: w.timeZone });
  return viaEmail(deps, doc.accountId, inv.email, m, displayFrom(w));
}

/** The verification code always goes by email, to the address the document was sent to. */
export async function deliverCode(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: string, code: string): Promise<Delivery> {
  return viaEmail(deps, doc.accountId, to, codeEmail({ locale: doc.locale, workspace: w.name, title: doc.title, code }), displayFrom(w));
}

/** The signed copy, to a signer or the sender: attached when it fits, always with a link. */
export async function deliverCompleted(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: Party, pdf: { bytes: Uint8Array; filename: string } | null, downloadUrl?: string): Promise<Delivery> {
  const attachable = pdf && pdf.bytes.byteLength <= 20 * 1024 * 1024;
  const m = completedEmail({ locale: to.locale, workspace: w.name, name: to.name, title: doc.title, attached: !!attachable, downloadUrl });
  const attachments = attachable ? [{ filename: pdf!.filename, content: Buffer.from(pdf!.bytes).toString("base64") }] : undefined;
  return viaEmail(deps, doc.accountId, to.email, m, displayFrom(w), attachments);
}

export type Outcome = { kind: "declined"; by: string; reason?: string | null } | { kind: "expired" } | { kind: "voided" };

/** Tell someone how a document ended when it did not complete. */
export async function deliverOutcome(deps: NotifyDeps, doc: DocFacts, w: Workspace, to: Party, outcome: Outcome): Promise<Delivery> {
  const m =
    outcome.kind === "declined"
      ? declinedEmail({ locale: to.locale, workspace: w.name, name: outcome.by, title: doc.title, reason: outcome.reason })
      : outcome.kind === "expired"
        ? expiredEmail({ locale: to.locale, workspace: w.name, title: doc.title })
        : voidedEmail({ locale: to.locale, workspace: w.name, title: doc.title });
  return viaEmail(deps, doc.accountId, to.email, m, displayFrom(w));
}
