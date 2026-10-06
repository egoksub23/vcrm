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
import { markTestPages } from "../pdf/testmark";
import { resolveDefaults, expiryFor } from "../defaults";
import { sendProblems, type Issue, type SignerDraft } from "../rules";
import { documentPath, getFile, putFile, removeFiles } from "../storage";
import { isFormMode, type Invitation, type SignDocumentRow, type SignSignerRow } from "../types";
import { loadDocument, loadSenderAndWorkspace, loadSettings, loadSigners, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf, loadFormState, unfinishedParts } from "./form-state";
import { refreshFormLists } from "./lists";
import { emitSignEvent } from "./outbound";

const toDraft = (s: SignSignerRow): SignerDraft => ({ role_key: s.role_key, kind: s.kind, full_name: s.full_name, email: s.email, phone: s.phone, channel: s.channel, order_no: s.order_no });

export interface InvitationResult {
  signerId: string;
  name: string;
  roleKey: string;
  delivery: Delivery;
  /** Only present when the message could not be delivered, so the sender can pass the link on. Never logged. */
  link?: string;
  /** The person's step has not begun: their details changed and nothing was sent (they are invited when their step begins). */
  notInvitedYet?: boolean;
}

export interface SendResult {
  documentId: string;
  reference: string | null;
  expiresAt: string;
  invited: InvitationResult[];
}

export async function workspaceFor(ctx: SignCtx, doc: SignDocumentRow): Promise<Workspace> {
  const [info, settings] = await Promise.all([loadSenderAndWorkspace(ctx, doc.created_by), loadSettings(ctx)]);
  return { name: info.workspaceName, senderName: info.senderName, timeZone: info.timeZone, settings };
}

export const docFacts = (doc: SignDocumentRow, ctx: SignCtx): DocFacts => ({
  accountId: ctx.accountId,
  // every message about a test document (invitation, reminder, code, outcome) says TEST in its subject and body, by its title
  title: doc.test ? `[TEST] ${doc.title}` : doc.title,
  reference: doc.reference,
  locale: doc.locale,
  expiresAt: doc.expires_at ? new Date(doc.expires_at) : null,
  codeRequired: doc.code_required,
  message: doc.message,
  mode: isFormMode(doc) ? "form" : "sign",
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

/**
 * Everything that stands between a DRAFT and "Send", for one document: its layout, its people, its form. Empty when it can go. A document
 * alone and each document of an envelope are held to exactly the same rules.
 */
export function readinessProblems(doc: SignDocumentRow, signers: readonly SignSignerRow[]): Issue[] {
  const problems = sendProblems({
    fields: doc.fields_snapshot,
    roles: doc.roles_snapshot,
    signers: signers.map(toDraft),
    signInOrder: doc.sign_in_order,
    pageCount: doc.page_count ?? 0,
    hasBaseFile: !!doc.base_path,
    mode: doc.mode,
  });
  // a form must be sound with the placements that print it, and every part needs a person to complete it
  const form = formOf(doc);
  // a form without a signature is only a form: without a part there is nothing to fill in (the rest of its rules are sendProblems')
  if (isFormMode(doc) && !(form && form.parts.length > 0)) problems.push({ code: "form_mode_needs_a_form" });
  if (form) problems.push(...validateForm(form, doc.roles_snapshot, doc.fields_snapshot), ...formSendProblems(form, signers));
  else if (doc.fields_snapshot.some((f) => f.data !== undefined)) problems.push(...validateForm({ version: 1, parts: [], fields: [] }, doc.roles_snapshot, doc.fields_snapshot));
  return problems;
}

/**
 * The form is frozen with the document: the lists it names are read once more, so the people invited get the lists as they are now, and
 * from here on a change to a list never reaches this document (the trigger refuses to change a sent document's form). Changes `doc` to match.
 */
export async function refreshFormSnapshot(ctx: SignCtx, doc: SignDocumentRow): Promise<void> {
  const form = formOf(doc);
  if (!form) return;
  const fresh = await refreshFormLists(ctx, form);
  if (JSON.stringify(fresh) !== JSON.stringify(form)) {
    const u = await ctx.admin.from("sign_documents").update({ form_snapshot: fresh }).eq("id", doc.id).eq("account_id", ctx.accountId).eq("status", "draft");
    if (u.error) raiseDatabaseError(u.error, "refresh the lists of the form");
    doc.form_snapshot = fresh;
  }
}

/** The month's limit for a document that counts (a test never does). Throws the limit's SignError (429). */
export async function assertRoomToSend(ctx: SignCtx, doc: { test?: boolean }): Promise<void> {
  if (doc.test) return;
  try {
    await assertCanSendDocument(ctx.admin, ctx.accountId);
  } catch (err) {
    if (err instanceof UsageLimitError) throw new SignError(err.code, err.message, 429);
    throw err;
  }
}

/**
 * Freeze: write the sender's values onto the file and fingerprint it, and store it under its own name. From here the file never changes.
 * A test document (F-10) is marked TEST on every page before it is fingerprinted: signers see the mark while they sign and the sealed
 * copy inherits it. The caller removes the stored file if the database then refuses the send.
 */
export async function freezeForSend(ctx: SignCtx, doc: SignDocumentRow, w: Workspace): Promise<{ path: string; sha256: string; size: number }> {
  const working = await getFile(ctx.admin, doc.base_path!, ctx.accountId);
  const plain = await freezeBase(working, doc.fields_snapshot, doc.merge_values, { locale: doc.locale, timeZone: w.timeZone });
  const frozen = doc.test ? { ...plain, ...(await markTestPages(plain.bytes)) } : plain;
  const path = documentPath(ctx.accountId, doc.id, "base", `sent-${frozen.sha256}.pdf`);
  await putFile(ctx.admin, path, frozen.bytes, "application/pdf");
  return { path, sha256: frozen.sha256, size: frozen.bytes.byteLength };
}

/** A document of an envelope is sent, cancelled, reminded and changed with its envelope (migration 171). */
export function assertNotInEnvelope(doc: Pick<SignDocumentRow, "envelope_id">): void {
  if (doc.envelope_id) throw new SignError("document_in_envelope", "This document is part of an envelope. Do this on the envelope.", 409);
}

export async function sendDocument(ctx: SignCtx, documentId: string): Promise<SendResult> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "This document was already sent.", 409);
  assertNotInEnvelope(doc);
  const signers = await loadSigners(ctx, documentId);

  const problems = readinessProblems(doc, signers);
  if (problems.length) throw new SignError("not_ready", "This document is not ready to send.", 400, problems);

  await refreshFormSnapshot(ctx, doc);

  // a test document never counts against the monthly limit (migration 170 leaves it out of the count too), so it is not stopped by it either
  await assertRoomToSend(ctx, doc);

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
  const frozen = await freezeForSend(ctx, doc, w);
  const frozenPath = frozen.path;

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
  await emitSignEvent(ctx, sent, "sent"); // the automation trigger and the webhook; never throws
  const invited = await deliverAll(ctx, sent, w, result.invited ?? []);
  return { documentId, reference: result.reference ?? doc.reference, expiresAt: expiresAt.toISOString(), invited };
}

// ---- after sending ------------------------------------------------------------------------

export async function voidDocument(ctx: SignCtx, documentId: string, reason: string | null): Promise<void> {
  const doc = await loadDocument(ctx, documentId);
  assertNotInEnvelope(doc);
  const signers = await loadSigners(ctx, documentId);
  const { error } = await ctx.admin.rpc("sign_void_document", { p_document: documentId, p_reason: reason, p_actor: ctx.userId });
  if (error) raiseDatabaseError(error, "void document");
  // Tell the people who had been invited and had not signed.
  if (doc.status !== "draft") {
    await emitSignEvent(ctx, { ...doc, status: "voided" }, "voided"); // the automation trigger and the webhook; never throws
    const w = await workspaceFor(ctx, doc);
    const facts = docFacts(doc, ctx);
    for (const s of signers.filter((x) => x.invited_at && x.status !== "signed" && x.status !== "declined")) {
      await deliverOutcome(ctx.deps, facts, w, { name: s.full_name, email: s.email, channel: s.channel, locale: doc.locale }, { kind: "voided" });
    }
  }
}

async function ownSigner(ctx: SignCtx, documentId: string, signerId: string): Promise<{ doc: SignDocumentRow; signer: SignSignerRow }> {
  const doc = await loadDocument(ctx, documentId);
  // remind, resend, change recipient and move act on the person across the whole envelope, so never through one document of it
  assertNotInEnvelope(doc);
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
    const { state, signers } = await loadFormState(ctx, doc, form);
    // only what this person can do: not a part they handed to someone, and a person handed parts is named only those
    return unfinishedParts(form, signer.role_key, state, { signer, signers }).map((p) => pick(p.title, doc.locale));
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
  const { doc, signer } = await ownSigner(ctx, documentId, signerId);
  if (!change.fullName.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(change.email.trim())) {
    throw new SignError("signer_details", "Enter a full name and a valid email.", 400);
  }
  // with signing order the same person cannot be on the document twice (the rule that stops it being sent), nor can one person
  // hold two places of the same role
  const email = change.email.trim().toLowerCase();
  const others = (await loadSigners(ctx, documentId)).filter((s) => s.id !== signerId);
  if (others.some((s) => s.email.trim().toLowerCase() === email && (doc.sign_in_order || s.role_key === signer.role_key))) {
    throw new SignError("already_on_document", "That person is already on this document.", 400);
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
  // a person whose step has not begun has no link yet: the details changed and nothing is sent
  if (!(data as Invitation).token) return { signerId, name: (data as Invitation).name, roleKey: (data as Invitation).role_key, delivery: { channel: (data as Invitation).channel, status: "sent" }, notInvitedYet: true };
  const w = await workspaceFor(ctx, doc);
  const [r] = await deliverAll(ctx, doc, w, [data as Invitation]);
  return r;
}

/**
 * A person whose step has not begun moves to a later step (F-70). Only while the document needs signing order and
 * only into a step that has not begun: the database decides under the lock, so two senders cannot disagree.
 */
export async function moveSigner(ctx: SignCtx, documentId: string, signerId: string, orderNo: unknown): Promise<{ signerId: string; orderNo: number }> {
  await ownSigner(ctx, documentId, signerId);
  const n = typeof orderNo === "number" ? orderNo : Number(orderNo);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new SignError("step_not_movable", "Choose a step from 1 to 100.", 400);
  const { data, error } = await ctx.admin.rpc("sign_move_signer", { p_signer: signerId, p_order_no: n, p_actor: ctx.userId });
  if (error || !data) raiseDatabaseError(error, "move signer");
  return { signerId, orderNo: n };
}
