// ============================================================
// Sending a document and managing it afterwards: send, void, remind, resend, change a recipient.
//
// Sending freezes the file (the sender's static and merge values are written onto it and it is
// fingerprinted), then the database moves the document to "sent" and invites the first step in one
// atomic call (migration 158). Links are created by the database for the people invited and handed
// back once; this module delivers them and does not keep them. A person who could not be reached is
// reported with a delivery status and an audit event; the document is sent regardless.
// ============================================================

import { assertCanSendDocument, forgetAccountUsage, UsageLimitError } from "@/lib/platform/usage";

import { formSendProblems, pick, validateForm } from "../forms";
import { deliverInvitation, deliverReminder, deliverOutcome, type Delivery, type DocFacts, type Workspace } from "../notify";
import { freezeBase } from "../pdf/stamp";
import { resolveDefaults, expiryFor } from "../defaults";
import { sendProblems, type SignerDraft } from "../rules";
import { documentPath, getFile, putFile, removeFiles } from "../storage";
import type { Invitation, SignDocumentRow, SignSignerRow } from "../types";
import { loadDocument, loadSenderAndWorkspace, loadSettings, loadSigners, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf, loadFormState, unfinishedParts } from "./form-state";

const toDraft = (s: SignSignerRow): SignerDraft => ({ role_key: s.role_key, kind: s.kind, full_name: s.full_name, email: s.email, phone: s.phone, channel: s.channel, order_no: s.order_no });

export interface InvitationResult {
  signerId: string;
  name: string;
  roleKey: string;
  delivery: Delivery;
  /** Only present when the message could not be delivered, so the sender can pass the link on. Never logged. */
  link?: string;
}

export interface SendResult {
  documentId: string;
  reference: string | null;
  expiresAt: string;
  invited: InvitationResult[];
}

async function workspaceFor(ctx: SignCtx, doc: SignDocumentRow): Promise<Workspace> {
  const [info, settings] = await Promise.all([loadSenderAndWorkspace(ctx, doc.created_by), loadSettings(ctx)]);
  return { name: info.workspaceName, senderName: info.senderName, timeZone: info.timeZone, settings };
}

export const docFacts = (doc: SignDocumentRow, ctx: SignCtx): DocFacts => ({
  accountId: ctx.accountId,
  title: doc.title,
  reference: doc.reference,
  locale: doc.locale,
  expiresAt: doc.expires_at ? new Date(doc.expires_at) : null,
  codeRequired: doc.code_required,
  message: doc.message,
});

/** Deliver a batch of fresh invitations, record failures, and build what the caller shows. */
async function deliverAll(ctx: SignCtx, doc: SignDocumentRow, w: Workspace, invited: Invitation[], reminder = false, partsLeft?: string[]): Promise<InvitationResult[]> {
  const facts = docFacts(doc, ctx);
  const out: InvitationResult[] = [];
  for (const inv of invited) {
    const delivery = reminder
      ? await deliverReminder(ctx.admin, ctx.deps, ctx.origin, facts, w, inv, partsLeft)
      : await deliverInvitation(ctx.admin, ctx.deps, ctx.origin, facts, w, inv, { fill: inv.kind === "filler" });
    if (delivery.status !== "sent") {
      await logEvent(ctx, doc.id, "delivery_failed", { actor: "system", signerId: inv.signer_id, detail: { channel: delivery.channel, status: delivery.status, reason: delivery.detail ?? null } });
    }
    out.push({
      signerId: inv.signer_id,
      name: inv.name,
      roleKey: inv.role_key,
      delivery,
      ...(delivery.status === "sent" ? {} : { link: `${ctx.origin.replace(/\/+$/, "")}/s/${inv.token}` }),
    });
  }
  return out;
}

export async function sendDocument(ctx: SignCtx, documentId: string): Promise<SendResult> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "This document was already sent.", 409);
  const signers = await loadSigners(ctx, documentId);

  const problems = sendProblems({
    fields: doc.fields_snapshot,
    roles: doc.roles_snapshot,
    signers: signers.map(toDraft),
    signInOrder: doc.sign_in_order,
    pageCount: doc.page_count ?? 0,
    hasBaseFile: !!doc.base_path,
  });
  // a form must be sound with the placements that print it, and every part needs a person to complete it
  const form = formOf(doc);
  if (form) problems.push(...validateForm(form, doc.roles_snapshot, doc.fields_snapshot), ...formSendProblems(form, signers));
  else if (doc.fields_snapshot.some((f) => f.data !== undefined)) problems.push(...validateForm({ version: 1, parts: [], fields: [] }, doc.roles_snapshot, doc.fields_snapshot));
  if (problems.length) throw new SignError("not_ready", "This document is not ready to send.", 400, problems);

  try {
    await assertCanSendDocument(ctx.admin, ctx.accountId);
  } catch (err) {
    if (err instanceof UsageLimitError) throw new SignError(err.code, err.message, 429);
    throw err;
  }

  const [settings, w] = await Promise.all([loadSettings(ctx), workspaceFor(ctx, doc)]);
  let category: { expiry_days: number | null } | null = null;
  if (doc.category_id) {
    const c = await ctx.admin.from("sign_categories").select("expiry_days").eq("id", doc.category_id).eq("account_id", ctx.accountId).maybeSingle();
    category = (c.data as { expiry_days: number | null } | null) ?? null;
  }
  const defaults = resolveDefaults({ category, workspace: settings });
  const now = ctx.now();
  const expiresAt = expiryFor(now, defaults.expiryDays, doc.expires_at);
  if (expiresAt.getTime() <= now.getTime()) throw new SignError("expiry_in_the_past", "The expiry date is in the past.", 400);

  // Freeze: write the sender's values onto the file and fingerprint it. From here the file never changes.
  const working = await getFile(ctx.admin, doc.base_path!, ctx.accountId);
  const frozen = await freezeBase(working, doc.fields_snapshot, doc.merge_values, { locale: doc.locale, timeZone: w.timeZone });
  const frozenPath = documentPath(ctx.accountId, documentId, "base", `sent-${frozen.sha256}.pdf`);
  await putFile(ctx.admin, frozenPath, frozen.bytes, "application/pdf");

  const { data, error } = await ctx.admin.rpc("sign_send_document", {
    p_document: documentId,
    p_base_path: frozenPath,
    p_base_sha256: frozen.sha256,
    p_page_count: doc.page_count,
    p_expires_at: expiresAt.toISOString(),
    p_actor: ctx.userId,
  });
  if (error || !data) {
    await removeFiles(ctx.admin, [frozenPath]);
    raiseDatabaseError(error, "send document");
  }
  forgetAccountUsage(ctx.accountId);

  const result = data as { reference: string | null; invited: Invitation[] };
  const sent: SignDocumentRow = { ...doc, status: "sent", expires_at: expiresAt.toISOString(), base_path: frozenPath, base_sha256: frozen.sha256 };
  const invited = await deliverAll(ctx, sent, w, result.invited ?? []);
  return { documentId, reference: result.reference ?? doc.reference, expiresAt: expiresAt.toISOString(), invited };
}

// ---- after sending ------------------------------------------------------------------------

export async function voidDocument(ctx: SignCtx, documentId: string, reason: string | null): Promise<void> {
  const doc = await loadDocument(ctx, documentId);
  const signers = await loadSigners(ctx, documentId);
  const { error } = await ctx.admin.rpc("sign_void_document", { p_document: documentId, p_reason: reason, p_actor: ctx.userId });
  if (error) raiseDatabaseError(error, "void document");
  // Tell the people who had been invited and had not signed.
  if (doc.status !== "draft") {
    const w = await workspaceFor(ctx, doc);
    const facts = docFacts(doc, ctx);
    for (const s of signers.filter((x) => x.invited_at && x.status !== "signed" && x.status !== "declined")) {
      await deliverOutcome(ctx.deps, facts, w, { name: s.full_name, email: s.email, channel: s.channel, locale: doc.locale }, { kind: "voided" });
    }
  }
}

async function ownSigner(ctx: SignCtx, documentId: string, signerId: string): Promise<{ doc: SignDocumentRow; signer: SignSignerRow }> {
  const doc = await loadDocument(ctx, documentId);
  const signer = (await loadSigners(ctx, documentId)).find((s) => s.id === signerId);
  if (!signer) throw new SignError("signer_not_found", "That person is not on this document.", 404);
  return { doc, signer };
}

/** A new link for someone who is waiting; the old one stops working. */
export async function resendSigner(ctx: SignCtx, documentId: string, signerId: string): Promise<InvitationResult> {
  const { doc } = await ownSigner(ctx, documentId, signerId);
  const { data, error } = await ctx.admin.rpc("sign_rotate_token", { p_signer: signerId, p_actor: ctx.userId, p_reason: "resent" });
  if (error || !data) raiseDatabaseError(error, "resend");
  const w = await workspaceFor(ctx, doc);
  const [r] = await deliverAll(ctx, doc, w, [data as Invitation]);
  return r;
}

/** For a document with a form: the titles, in the document's language, of the parts this person has not finished. */
async function partsLeftFor(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow): Promise<string[] | undefined> {
  const form = formOf(doc);
  if (!form) return undefined;
  try {
    const { state } = await loadFormState(ctx, doc, form);
    return unfinishedParts(form, signer.role_key, state).map((p) => pick(p.title, doc.locale));
  } catch (err) {
    console.error("[sign] could not list unfinished parts:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** A reminder is a message with a fresh link, recorded as its own event. */
export async function remindSigner(ctx: SignCtx, documentId: string, signerId: string): Promise<InvitationResult> {
  const { doc, signer } = await ownSigner(ctx, documentId, signerId);
  const { data, error } = await ctx.admin.rpc("sign_rotate_token", { p_signer: signerId, p_actor: ctx.userId, p_reason: "reminded" });
  if (error || !data) raiseDatabaseError(error, "remind");
  const w = await workspaceFor(ctx, doc);
  const [r] = await deliverAll(ctx, doc, w, [data as Invitation], true, await partsLeftFor(ctx, doc, signer));
  await ctx.admin
    .from("sign_signers")
    .update({ last_reminded_at: ctx.now().toISOString(), reminder_count: signer.reminder_count + 1 })
    .eq("id", signerId)
    .eq("account_id", ctx.accountId);
  return r;
}

export interface RecipientChange {
  fullName: string;
  email: string;
  phone?: string | null;
  channel?: "email" | "whatsapp";
}

/** A different person (or address) for someone who has not signed: a new link goes to the new address. */
export async function changeRecipient(ctx: SignCtx, documentId: string, signerId: string, change: RecipientChange): Promise<InvitationResult> {
  const { doc } = await ownSigner(ctx, documentId, signerId);
  if (!change.fullName.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(change.email.trim())) {
    throw new SignError("signer_details", "Enter a full name and a valid email.", 400);
  }
  const { data, error } = await ctx.admin.rpc("sign_change_recipient", {
    p_signer: signerId,
    p_name: change.fullName,
    p_email: change.email,
    p_phone: change.phone ?? "",
    p_channel: change.channel ?? null,
    p_actor: ctx.userId,
  });
  if (error || !data) raiseDatabaseError(error, "change recipient");
  const w = await workspaceFor(ctx, doc);
  const [r] = await deliverAll(ctx, doc, w, [data as Invitation]);
  return r;
}
