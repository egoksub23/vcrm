// ============================================================
// Envelopes (migration 171): the sender's side. An envelope groups 2 to 6 ordinary documents for the SAME people; each document stays a
// normal document (its own file, fields, form, answers, seal, certificate and audit chain), made by the same services a document on its
// own is made by. What this module adds is what is shared: the draft made from several templates, one signing list with a role on each
// document, one set of options, one send (limits checked for the whole envelope first), and remind, resend, change recipient, expiry
// and void for the envelope as a whole. See docs/sign-envelopes-design.md.
// ============================================================

import { randomUUID } from "node:crypto";

import { forgetAccountUsage, signSendHeadroom } from "@/lib/platform/usage";

import { cleanReminderDays, expiryFor, resolveDefaults } from "../defaults";
import { summarizeDocument, type EnvelopeDocumentSummary } from "../envelopes/summary";
import { ENVELOPE_MAX_BYTES, ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MAX_PAGES, ENVELOPE_MIN_DOCUMENTS, PERSON_KEY_RE, canVoidEnvelope, defaultOrder, deriveEnvelopeStatus, newPersonKey, peopleFromRows, peopleIssues, pruneRows, rowsFor, syncDocumentRoles, withDerivedRoles, type EnvelopeDocLite, type EnvelopePerson, type OrderEntry, type PersonType } from "../envelopes";
import type { ConvertOptions } from "../convert";
import { REMIND_GAP_MS } from "../defaults";
import { MAX_ROLES, type Issue } from "../rules";
import { removeFiles } from "../storage";
import { SIGN_LOCALES, isFormMode, type Invitation, type SignChannel, type SignCopyRecipientRow, type SignDocumentRow, type SignEnvelopeRow, type SignSignerRow } from "../types";
import { loadSettings, type SignCtx } from "./context";
import { createDraftFromTemplate, createDraftFromUpload, deleteDraft, deleteDocument, setSigners, updateDraft, type DraftPatch, type SignerInput } from "./drafts";
import { signedFileName } from "../file-names";
import { certificateOf } from "./certificate-files";
import { listCopyRecipients } from "./copy-recipients";
import type { CopyFile } from "./copy-delivery";
import { anchorOf, groupByParty, loadEnvelope, loadEnvelopeDocuments, loadEnvelopeSigners } from "./envelope-data";
import { deliverEnvelopeInvitations, envelopeWorkspace, notifyEnvelopeCompleted, notifyEnvelopeEnded } from "./envelope-delivery";
import { SignError, raiseDatabaseError } from "./errors";
import { resolveLinks } from "./links";
import { sealingIsStuck } from "./seal-retry";
import { emitSignEvent } from "./outbound";
import { assertMayChangePrivacy, assertMayEditDraft } from "./privacy";
import { extendExpiry } from "./progress";
import { freezeForSend, readinessProblems, refreshFormSnapshot, type InvitationResult } from "./send";
import { getFile } from "../storage";

// ---- reading ------------------------------------------------------------------------------------

export type { EnvelopeDocumentSummary };

export interface EnvelopeHeadroom {
  limit: number | null;
  used: number;
  remaining: number | null;
  needed: number;
  fits: boolean;
}

export interface EnvelopeData {
  envelope: SignEnvelopeRow;
  documents: EnvelopeDocumentSummary[];
  /** Every row of the signing list (a person has one row on each document they are on). */
  signers: SignSignerRow[];
  /** The people who receive a copy of the signed documents (they are not on the signing list), and whether each was sent it yet. */
  copies: SignCopyRecipientRow[];
  /** A draft: what stands between it and Send, document by document (each issue names its document), then the shared list. */
  problems: Issue[];
  /** A draft: whether the month's limit has room for all the documents. */
  headroom: EnvelopeHeadroom | null;
  /** The ticket and the deal the envelope's documents are attached to (the same on each). */
  links: { ticketId: string | null; dealId: string | null };
  /** The documents whose signed copy could not be made (marked failed, or still being tried with an error): the sender can ask for another try. `error` is why. */
  stuck?: { id: string; position: number; title: string; error: string | null }[];
}

export const lite = (d: SignDocumentRow): EnvelopeDocLite => ({ id: d.id, position: d.envelope_position ?? 0, title: d.title, roles: d.roles_snapshot ?? [], mode: isFormMode(d) ? "form" : "sign", fromTemplate: !!d.template_version_id });

/**
 * Everything that stands between a draft envelope and Send: each document's own problems (tagged with the document) and the shared list's.
 *
 * A person who must sign signs only the documents on which a field is assigned to them (the rest are left off at send: `pruneRows`), so each
 * document is held to what a document alone is held to with ITS signers being those people. A document nobody has anything to do on is
 * `document_nobody`, and a person with nothing to do on any document is `person_without_work`. People who receive a copy are not signers: they
 * are only checked for a name, an address, the limit, and not being on the signing list too.
 */
export function envelopeProblems(env: SignEnvelopeRow, docs: readonly SignDocumentRow[], signers: readonly SignSignerRow[], copies: readonly Pick<SignCopyRecipientRow, "id" | "full_name" | "email">[] = []): Issue[] {
  const out: Issue[] = [];
  if (docs.length < ENVELOPE_MIN_DOCUMENTS || docs.length > ENVELOPE_MAX_DOCUMENTS) out.push({ code: "envelope_size", detail: `${ENVELOPE_MIN_DOCUMENTS}-${ENVELOPE_MAX_DOCUMENTS}` });
  const pages = docs.reduce((n, d) => n + (d.page_count ?? 0), 0);
  if (pages > ENVELOPE_MAX_PAGES) out.push({ code: "envelope_too_many_pages", detail: String(ENVELOPE_MAX_PAGES) });
  const { keep } = pruneRows(docs, signers);
  for (const d of docs) {
    // each document is held to what a document alone is held to, with the envelope's own options in place of its own
    const asDoc: SignDocumentRow = { ...d, sign_in_order: env.sign_in_order, code_required: env.code_required };
    const mine = keep.filter((s) => s.document_id === d.id);
    // (two people on one role is the shared list's `role_two_people`, said once for the person who has to fix it)
    const found = readinessProblems(asDoc, mine).filter((i) => i.code !== "role_shared");
    if (mine.length === 0) {
      out.push({ code: "document_nobody", document: d.id });
      for (const i of found) if (i.code !== "no_signer" && i.code !== "no_person") out.push({ ...i, document: d.id });
    } else {
      for (const i of found) out.push({ ...i, document: d.id });
    }
  }
  const people = peopleFromRows(signers);
  const kept = new Set(keep.map((s) => s.id));
  people.forEach((p, i) => {
    if (!signers.some((s) => kept.has(s.id) && (s.party_id ?? s.id) === p.partyId)) out.push({ code: "person_without_work", detail: String(i) });
  });
  const copyPeople: EnvelopePerson[] = copies.map((c) => ({ key: c.id, fullName: c.full_name, email: c.email, phone: "", channel: "email", step: 1, roles: {}, type: "copy" }));
  out.push(...peopleIssues(docs.map(lite), [...people, ...copyPeople], { ordered: env.sign_in_order }));
  return out;
}

/** What the screens show of an envelope: itself, its documents, its people, and (as a draft) its problems and whether the limit has room. */
export async function envelopeData(ctx: SignCtx, envelopeId: string): Promise<EnvelopeData> {
  const envelope = await loadEnvelope(ctx, envelopeId);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const signers = await loadEnvelopeSigners(ctx, docs.map((d) => d.id));
  const copies = await listCopyRecipients(ctx, { envelopeId });
  const draft = envelope.status === "draft";
  let headroom: EnvelopeHeadroom | null = null;
  if (draft) {
    const room = await signSendHeadroom(ctx.admin, ctx.accountId);
    const needed = docs.length;
    headroom = { limit: room.limit, used: room.used, remaining: room.remaining, needed, fits: room.remaining === null || needed <= room.remaining };
  }
  const stuck = docs.filter(sealingIsStuck).map((d) => ({ id: d.id, position: d.envelope_position ?? 0, title: d.title, error: d.seal_error?.trim() || null }));
  return { envelope, documents: docs.map(summarizeDocument), signers, copies, problems: draft ? envelopeProblems(envelope, docs, signers, copies) : [], headroom, links: { ticketId: docs[0]?.ticket_id ?? null, dealId: docs[0]?.deal_id ?? null }, stuck };
}

/** What a document's own screen says of the envelope it is in: the envelope and its siblings, no more. */
export interface EnvelopeBrief {
  id: string;
  reference: string | null;
  title: string;
  status: SignEnvelopeRow["status"];
  expiresAt: string | null;
  /** Migration 181: when the (completed) collection was cancelled, with every document in it. Null when it was not. */
  cancelledAt: string | null;
  documents: { id: string; position: number; title: string; reference: string | null; status: SignDocumentRow["status"]; mode: "sign" | "form" }[];
}

/** The envelope a document is in, for the document's own screen. Null for a document on its own. */
export async function envelopeBrief(ctx: SignCtx, envelopeId: string | null | undefined): Promise<EnvelopeBrief | null> {
  if (!envelopeId) return null;
  const [env, docs] = await Promise.all([loadEnvelope(ctx, envelopeId), loadEnvelopeDocuments(ctx, envelopeId)]);
  return {
    id: env.id,
    reference: env.reference,
    title: env.title,
    status: env.status,
    expiresAt: env.expires_at,
    cancelledAt: env.status === "completed" ? (env.cancelled_at ?? null) : null,
    documents: docs.map((d) => ({ id: d.id, position: d.envelope_position ?? 0, title: d.title, reference: d.reference, status: d.status, mode: isFormMode(d) ? "form" : "sign" })),
  };
}

// ---- making one ---------------------------------------------------------------------------------

/** A file of the sender's own that becomes a document of the collection (the bytes are checked and converted as for any document). */
export interface EnvelopeUpload {
  bytes: Uint8Array;
  filename: string;
  converter?: ConvertOptions;
}

export interface EnvelopeDraftArgs {
  title?: string | null;
  templateIds: readonly string[];
  /** One uploaded file as the first document, with the templates after it. */
  file?: EnvelopeUpload | null;
  /** Several uploaded files (after `file`, when both are given). */
  files?: readonly EnvelopeUpload[];
  /**
   * The documents in the order they are signed: files (by their place in `file`, then `files`) and templates interleaved, each with an optional
   * title of the sender's. When absent, the files in the order they came, then `templateIds`. When present, `templateIds` is not used.
   */
  order?: readonly OrderEntry[];
  contactId?: string | null;
  ticketId?: string | null;
  dealId?: string | null;
  /** Migration 176: a private collection, and so every document of it: seen only by its uploader, the workspace's admins and the Halo users named on it. */
  isPrivate?: boolean;
}

async function templateNames(ctx: SignCtx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await ctx.admin.from("sign_templates").select("id, name, current_version_id").in("id", [...ids]).eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "load templates");
  return new Map(((data ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
}

/**
 * The list of documents to make, checked: every file named once and every template once, a template that is not this workspace's refused.
 * Returns the names of the templates (by id). Nothing is made here.
 */
export async function checkEntries(ctx: SignCtx, entries: readonly OrderEntry[], uploads: number): Promise<Map<string, string>> {
  const usedFiles = new Set<number>();
  const ids: string[] = [];
  for (const e of entries) {
    if (e.kind === "file") {
      if (!Number.isInteger(e.index) || e.index < 0 || e.index >= uploads || usedFiles.has(e.index)) throw new SignError("bad_order", "The order of the documents is not valid.", 400);
      usedFiles.add(e.index);
    } else {
      ids.push(e.id);
    }
  }
  if (usedFiles.size !== uploads) throw new SignError("bad_order", "The order of the documents is not valid.", 400);
  if (new Set(ids).size !== ids.length) throw new SignError("envelope_duplicate_template", "Choose each template once.", 400);
  const names = await templateNames(ctx, ids);
  for (const id of ids) if (!names.has(id)) throw new SignError("template_not_found", "That template was not found.", 404);
  return names;
}

/**
 * Make the documents of `entries` as drafts of an envelope, in order, from the first place after `from`: each by the same service a document
 * alone is made by (conversion, limits and checks unchanged). Every document made is pushed on `made` as it is, so the caller can remove them
 * again when a later one fails (the work is all or nothing).
 */
export async function makeEntryDocuments(
  ctx: SignCtx,
  envelopeId: string,
  from: number,
  entries: readonly OrderEntry[],
  uploads: readonly EnvelopeUpload[],
  link: { contactId: string | null; ticketId: string | null; dealId: string | null; isPrivate?: boolean },
  made: SignDocumentRow[],
): Promise<void> {
  let position = from;
  for (const e of entries) {
    position += 1;
    const title = e.title?.trim() ? e.title.trim() : undefined;
    if (e.kind === "file") {
      const up = uploads[e.index];
      const m = await createDraftFromUpload(ctx, { bytes: up.bytes, filename: up.filename, converter: up.converter, title, ...link, envelope: { id: envelopeId, position } });
      made.push(m.document);
    } else {
      made.push(await createDraftFromTemplate(ctx, { templateId: e.id, title, ...link, envelope: { id: envelopeId, position } }));
    }
  }
}

/**
 * Make a collection as a draft from two to six documents: any mix of files and templates, in the order given (or the files, then the templates).
 * The envelope, then each document through the same service a document alone is made by, in order. Whatever was made is removed again when any
 * step fails. The envelope starts with the options of the workspace and the strictest of the documents' (signing order and code on when any
 * asks for them).
 */
export async function createEnvelopeDraft(ctx: SignCtx, args: EnvelopeDraftArgs): Promise<{ envelope: SignEnvelopeRow; documents: SignDocumentRow[] }> {
  const uploads: EnvelopeUpload[] = [...(args.file ? [args.file] : []), ...(args.files ?? [])];
  const entries: readonly OrderEntry[] = args.order ?? defaultOrder(uploads.length, args.templateIds);
  const total = entries.length;
  if (total < ENVELOPE_MIN_DOCUMENTS || total > ENVELOPE_MAX_DOCUMENTS) throw new SignError("envelope_size", `A collection has ${ENVELOPE_MIN_DOCUMENTS} to ${ENVELOPE_MAX_DOCUMENTS} documents.`, 400);
  const title = (args.title ?? "").trim();
  if (title.length > 200) throw new SignError("bad_title", "Give the collection a title of up to 200 characters.", 400);
  const names = await checkEntries(ctx, entries, uploads.length);

  // the same checks a document alone gets: the contact, the ticket and the deal belong to this workspace and agree with each other
  let checkedContact: string | null = null;
  if (args.contactId) {
    const c = await ctx.admin.from("contacts").select("id").eq("id", args.contactId).eq("account_id", ctx.accountId).is("deleted_at", null).maybeSingle();
    if (c.error) raiseDatabaseError(c.error, "load contact");
    if (!c.data) throw new SignError("contact_not_found", "That contact was not found.", 400);
    checkedContact = args.contactId;
  }
  const links = await resolveLinks(ctx, { contactId: checkedContact, ticketId: args.ticketId, dealId: args.dealId });

  const settings = await loadSettings(ctx);
  const defaults = resolveDefaults({ workspace: settings });
  const first = entries[0];
  const fallbackTitle = first.kind === "file" ? (first.title ?? uploads[first.index].filename.replace(/\.[A-Za-z0-9]{1,5}$/, "")) : (first.title ?? names.get(first.id) ?? "Documents");
  const inserted = await ctx.admin
    .from("sign_envelopes")
    .insert({
      account_id: ctx.accountId,
      title: (title || `${fallbackTitle} and ${total - 1} more`).slice(0, 200),
      contact_id: links.contactId,
      locale: defaults.locale,
      reminder_days: defaults.reminderDays,
      ...(args.isPrivate ? { is_private: true } : {}),
      created_by: ctx.userId,
    })
    .select("*")
    .single();
  if (inserted.error || !inserted.data) raiseDatabaseError(inserted.error, "create envelope");
  let envelope = inserted.data as SignEnvelopeRow;

  const documents: SignDocumentRow[] = [];
  const undo = async () => {
    for (const d of documents) await deleteDraft(ctx, d.id, { viaEnvelope: true }).catch(() => undefined);
    await ctx.admin.from("sign_envelopes").delete().eq("id", envelope.id).eq("account_id", ctx.accountId);
  };
  try {
    await makeEntryDocuments(ctx, envelope.id, 0, entries, uploads, { contactId: links.contactId, ticketId: links.ticketId, dealId: links.dealId, isPrivate: args.isPrivate === true }, documents);

    // the options the people will meet: the strictest of the documents' own (signing order and code on when any asks), the first message
    // any of them has, then written to every document so they agree from the start
    const patch = {
      sign_in_order: documents.some((d) => d.sign_in_order),
      code_required: documents.some((d) => d.code_required),
      message: documents.find((d) => d.message?.trim())?.message?.trim() ?? null,
    };
    const upd = await ctx.admin.from("sign_envelopes").update(patch).eq("id", envelope.id).eq("account_id", ctx.accountId).select("*").single();
    if (upd.error || !upd.data) raiseDatabaseError(upd.error, "set the options of the envelope");
    envelope = upd.data as SignEnvelopeRow;
    const fresh = await applyEnvelopeOptions(ctx, envelope, documents);
    return { envelope, documents: fresh };
  } catch (err) {
    await undo();
    throw err;
  }
}

// ---- options ------------------------------------------------------------------------------------

/** Write the envelope's options onto each of its draft documents (one signing order, code, language, message, expiry and reminders for all). */
export async function applyEnvelopeOptions(ctx: SignCtx, env: SignEnvelopeRow, docs: readonly SignDocumentRow[]): Promise<SignDocumentRow[]> {
  const out: SignDocumentRow[] = [];
  for (const d of docs) {
    const patch: DraftPatch = {
      signInOrder: env.sign_in_order,
      codeRequired: env.code_required,
      locale: env.locale,
      message: env.message,
      reminderDays: env.reminder_days ?? [],
      allowForwarding: false,
      // the collection decides: each document is private exactly when it is (the database holds that too)
      isPrivate: env.is_private === true,
      // the expiry is checked when it is set; a date that has since passed is left for the send to refuse
      ...(env.expires_at && new Date(env.expires_at).getTime() > ctx.now().getTime() ? { expiresAt: env.expires_at } : {}),
    };
    out.push(await updateDraft(ctx, d.id, patch, { viaEnvelope: true }));
  }
  return out;
}

export interface EnvelopePatch {
  title?: string;
  message?: string | null;
  locale?: string;
  expiresAt?: string | null;
  signInOrder?: boolean;
  codeRequired?: boolean;
  reminderDays?: number[];
  contactId?: string | null;
  ticketId?: string | null;
  dealId?: string | null;
  /** Migration 176: only its uploader or an admin may change it, and only while the collection is a draft. */
  isPrivate?: boolean;
}

/** Change what an envelope shares. Only while it is a draft. The options go onto every document in the same step. */
export async function updateEnvelope(ctx: SignCtx, envelopeId: string, patch: EnvelopePatch): Promise<SignEnvelopeRow> {
  const env = await loadEnvelope(ctx, envelopeId);
  if (env.status !== "draft") throw new SignError("envelope_not_draft", "This document collection was already sent.", 409);
  await assertMayEditDraft(ctx, env);
  const update: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (t.length < 1 || t.length > 200) throw new SignError("bad_title", "Give the collection a title of up to 200 characters.", 400);
    update.title = t;
  }
  if (patch.message !== undefined) {
    if (patch.message !== null && patch.message.length > 2000) throw new SignError("bad_message", "The message can be up to 2000 characters.", 400);
    update.message = patch.message?.trim() ? patch.message.trim() : null;
  }
  if (patch.locale !== undefined) {
    if (!SIGN_LOCALES.includes(patch.locale as never)) throw new SignError("bad_locale", "Choose English, Bahasa Melayu, Chinese or Korean.", 400);
    update.locale = patch.locale;
  }
  if (patch.expiresAt !== undefined) {
    if (patch.expiresAt === null) update.expires_at = null;
    else {
      const d = new Date(patch.expiresAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= ctx.now().getTime()) throw new SignError("expiry_in_the_past", "The expiry date must be in the future.", 400);
      update.expires_at = d.toISOString();
    }
  }
  if (patch.signInOrder !== undefined) update.sign_in_order = !!patch.signInOrder;
  if (patch.codeRequired !== undefined) update.code_required = !!patch.codeRequired;
  if (patch.reminderDays !== undefined) update.reminder_days = cleanReminderDays(patch.reminderDays);
  if (patch.isPrivate !== undefined) {
    if (typeof patch.isPrivate !== "boolean") throw new SignError("bad_private", "Choose whether this is private.", 400);
    if (patch.isPrivate !== (env.is_private === true)) {
      await assertMayChangePrivacy(ctx, env);
      update.is_private = patch.isPrivate;
    }
  }

  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  // the contact, the ticket and the deal of an envelope are the documents' too (so each shows on the contact's, the ticket's and the deal's panels)
  let linkPatch: DraftPatch | null = null;
  if (patch.contactId !== undefined || patch.ticketId !== undefined || patch.dealId !== undefined) {
    let contact = patch.contactId !== undefined ? patch.contactId : env.contact_id;
    if (patch.contactId) {
      const c = await ctx.admin.from("contacts").select("id").eq("id", patch.contactId).eq("account_id", ctx.accountId).is("deleted_at", null).maybeSingle();
      if (c.error) raiseDatabaseError(c.error, "load contact");
      if (!c.data) throw new SignError("contact_not_found", "That contact was not found.", 400);
    }
    const lead = docs[0];
    const links = await resolveLinks(ctx, { contactId: contact, ticketId: patch.ticketId !== undefined ? patch.ticketId : (lead?.ticket_id ?? null), dealId: patch.dealId !== undefined ? patch.dealId : (lead?.deal_id ?? null) });
    contact = links.contactId;
    update.contact_id = contact;
    linkPatch = { contactId: links.contactId, ticketId: links.ticketId, dealId: links.dealId };
  }

  let saved = env;
  if (Object.keys(update).length > 0) {
    const { data, error } = await ctx.admin.from("sign_envelopes").update(update).eq("id", envelopeId).eq("account_id", ctx.accountId).eq("status", "draft").select("*").maybeSingle();
    if (error) raiseDatabaseError(error, "update envelope");
    if (!data) throw new SignError("envelope_not_draft", "This document collection was already sent.", 409);
    saved = data as SignEnvelopeRow;
  }
  if (Object.keys(update).some((k) => k !== "title")) await applyEnvelopeOptions(ctx, saved, docs);
  if (linkPatch) for (const d of docs) await updateDraft(ctx, d.id, linkPatch, { viaEnvelope: true });
  return saved;
}

// ---- the signing list -----------------------------------------------------------------------------

export interface EnvelopePersonInput {
  fullName: string;
  email: string;
  phone?: string | null;
  channel: SignChannel;
  /** The signing step; only meaningful when the envelope needs signing order. */
  step?: number;
  /**
   * The role this person has on each document that came from a TEMPLATE, by document id (a document left out is one they are not on). Ignored
   * for an uploaded file: its roles are made from the people.
   */
  roles: Record<string, string>;
  /** "signer" (the default) or "copy". A person who receives a copy is not saved here (see copy-recipients.ts); they are left out of the signing list. */
  type?: PersonType;
  /** The person's stable key (a `pp_` key the screen keeps for them): it becomes their role on the uploaded documents, so a rename keeps the fields assigned to them. */
  key?: string;
  /** A document on its own only: the person is a Halo user of this workspace (a countersigner). */
  internalUserId?: string | null;
  /**
   * A person the screen is still filling in (no valid address yet, say). They are not saved as a signer (nothing is checked or invited), but their
   * role on the uploaded documents is KEPT with the fields assigned to it, so a half-typed address never takes work away. A new person with no name
   * who has no role yet is simply ignored.
   */
  incomplete?: boolean;
}

/** Write a signing list to the documents (the same service a document alone uses), each person's rows tied together, the anchor on their first document. */
async function writeSigners(ctx: SignCtx, env: SignEnvelopeRow, docs: readonly SignDocumentRow[], people: readonly EnvelopePerson[]): Promise<SignSignerRow[]> {
  const rows = rowsFor(docs.map(lite), people, { ordered: env.sign_in_order, newId: randomUUID });
  const out: SignSignerRow[] = [];
  for (const d of docs) {
    const mine: SignerInput[] = rows
      .filter((r) => r.documentId === d.id)
      .map((r) => ({ id: r.id, partyId: r.partyId, roleKey: r.roleKey, kind: r.kind, fullName: r.fullName, email: r.email, phone: r.phone, channel: r.channel, orderNo: r.orderNo, ...(r.internalUserId ? { internalUserId: r.internalUserId } : {}) }));
    out.push(...(await setSigners(ctx, d.id, mine, { viaEnvelope: true })));
  }
  return out;
}

/**
 * Replace the shared signing list of a draft collection. One entry is one PERSON who must sign. Their roles come from the documents:
 *   - an uploaded file (no roles of its own) takes a role from each person: the person's key is the role's key and their name its label, kept
 *     in step with the people here (a rename keeps the key, so fields assigned to the person stay; a person taken off the list takes the
 *     fields assigned to them off the uploaded documents, since nobody could complete them);
 *   - a document from a template keeps the template's roles, and `roles` says which person has which.
 * The rows are written to each document (through the same service a document alone uses) tied together by the person's party id, the row on
 * their first document being the anchor. Refused, with the people it is about, when the list is not sound.
 */
export async function setEnvelopeSigners(ctx: SignCtx, envelopeId: string, people: readonly EnvelopePersonInput[]): Promise<SignSignerRow[]> {
  const env = await loadEnvelope(ctx, envelopeId);
  if (env.status !== "draft") throw new SignError("envelope_not_draft", "This document collection was already sent.", 409);
  await assertMayEditDraft(ctx, env);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const { list, derivedFinished } = planSigners(docs, people, { ordered: env.sign_in_order });

  // the uploaded documents take their roles from the people, and lose the fields of a person who is gone
  for (const d of docs.filter((x) => !x.template_version_id)) {
    const sync = syncDocumentRoles({ roles: d.roles_snapshot ?? [], fields: d.fields_snapshot ?? [] }, list);
    if (!sync.changed) continue;
    await updateDraft(ctx, d.id, { roles: sync.roles, ...(sync.removed > 0 ? { fields: sync.fields } : {}) }, { viaEnvelope: true });
  }
  const fresh = await loadEnvelopeDocuments(ctx, envelopeId);
  return writeSigners(ctx, env, fresh, derivedFinished);
}

/**
 * Check a list of people against the documents they are for, as a collection and a document on its own both do: only the people who must sign
 * are looked at here; a person the screen is still filling in keeps their role (and the fields assigned to it) on the uploaded documents; the
 * list is refused (400 bad_signers, with the people it is about) when it is not sound. `extraKeys` are keys, besides the `pp_` ones, that a
 * person may keep as their own (a document on its own that has a role of its own from before people made roles). Returns the people as the roles
 * will have them (`list`) and the finished ones once the uploaded documents have taken their roles (`derivedFinished`: the ones to save).
 */
export function planSigners(docs: readonly SignDocumentRow[], people: readonly EnvelopePersonInput[], opts: { ordered: boolean; extraKeys?: ReadonlySet<string> }): { list: EnvelopePerson[]; derivedFinished: EnvelopePerson[] } {
  const used = new Set<string>();
  // the roles the uploaded documents already hold for people: a person the screen is still filling in keeps theirs
  const held = new Set(docs.filter((d) => !d.template_version_id).flatMap((d) => (d.roles_snapshot ?? []).filter((r) => r.source === "people").map((r) => r.key)));
  const mayKeep = (key: string | undefined): key is string => !!key && (PERSON_KEY_RE.test(key) || !!opts.extraKeys?.has(key));
  const entries = people
    .filter((p) => (p.type ?? "signer") === "signer")
    .filter((p) => !p.incomplete || !!p.fullName.trim() || (!!p.key && (held.has(p.key) || !!opts.extraKeys?.has(p.key))))
    .map((p, i) => {
      let key = mayKeep(p.key) && !used.has(p.key) ? p.key : newPersonKey();
      while (used.has(key)) key = newPersonKey();
      used.add(key);
      const person: EnvelopePerson = { key, fullName: p.fullName, email: p.email, phone: p.phone ?? "", channel: p.channel, step: Math.max(1, Math.floor(p.step ?? i + 1)), roles: p.roles ?? {}, ...(p.internalUserId ? { internalUserId: p.internalUserId } : {}) };
      return { person, incomplete: !!p.incomplete };
    });
  const list = entries.map((e) => e.person);
  // an uploaded file holds a few roles, one for each person
  if (list.length > MAX_ROLES && docs.some((d) => !d.template_version_id)) throw new SignError("bad_signers", "The signing list is not valid.", 400, [{ code: "too_many_roles", detail: String(MAX_ROLES) }]);
  // what the people look like once the uploaded documents have taken their roles; only the finished ones are checked and saved
  const derived = withDerivedRoles(docs.map(lite), list);
  const finished = new Set(entries.filter((e) => !e.incomplete).map((e) => e.person.key));
  const derivedFinished = derived.people.filter((p) => finished.has(p.key));
  const issues = peopleIssues(derived.docs, derivedFinished, { ordered: opts.ordered }).filter((i) => i.code !== "person_without_document");
  // a person on no document is simply not saved (the screen lets a row be half made); every other problem stops the save
  if (issues.length > 0) throw new SignError("bad_signers", "The signing list is not valid.", 400, issues);
  return { list, derivedFinished };
}

// ---- sending ------------------------------------------------------------------------------------

export interface EnvelopeSendResult {
  envelopeId: string;
  reference: string | null;
  expiresAt: string;
  documents: { id: string; title: string; reference: string | null; position: number }[];
  /** One for each person invited (the first step): their documents share one link. */
  invited: InvitationResult[];
}

/**
 * Send every document of an envelope in one step. Everything is checked first (each document as a document alone is, the shared list, the
 * size, and the month's limit for ALL the documents: an envelope that does not fit is refused whole), then each file is frozen and the
 * database sends all the documents in one transaction and invites the first step with ONE invitation for each person.
 */
export async function sendEnvelope(ctx: SignCtx, envelopeId: string): Promise<EnvelopeSendResult> {
  const env = await loadEnvelope(ctx, envelopeId);
  if (env.status !== "draft") throw new SignError("envelope_not_draft", "This document collection was already sent.", 409);
  await assertMayEditDraft(ctx, env);
  let docs = await loadEnvelopeDocuments(ctx, envelopeId);
  if (docs.length < ENVELOPE_MIN_DOCUMENTS || docs.length > ENVELOPE_MAX_DOCUMENTS) throw new SignError("envelope_size", `A document collection has ${ENVELOPE_MIN_DOCUMENTS} to ${ENVELOPE_MAX_DOCUMENTS} documents.`, 400);
  // the envelope's options are on every document (they were written as they were edited; once more so nothing can differ)
  docs = await applyEnvelopeOptions(ctx, env, docs);
  const signers = await loadEnvelopeSigners(ctx, docs.map((d) => d.id));
  const copies = await listCopyRecipients(ctx, { envelopeId });

  const problems = envelopeProblems(env, docs, signers, copies);
  if (problems.length > 0) throw new SignError("envelope_not_ready", "This document collection is not ready to send.", 400, problems);

  // the limit is for the whole envelope: every document counts as a document sent, and none is sent if they do not all fit
  const room = await signSendHeadroom(ctx.admin, ctx.accountId);
  if (room.remaining !== null && docs.length > room.remaining) {
    throw new SignError("sign_limit_reached", "This workspace does not have room for all the documents of this collection this month.", 429, [{ code: "envelope_exceeds_limit", detail: `${docs.length}:${room.remaining}` }]);
  }

  for (const d of docs) await refreshFormSnapshot(ctx, d);

  const [settings, w] = await Promise.all([loadSettings(ctx), envelopeWorkspace(ctx, env.created_by)]);
  const defaults = resolveDefaults({ workspace: settings });
  const now = ctx.now();
  const expiresAt = expiryFor(now, defaults.expiryDays, env.expires_at);
  if (expiresAt.getTime() <= now.getTime()) throw new SignError("expiry_in_the_past", "The expiry date is in the past.", 400);

  // freeze every file; if one fails, or the total is too big, the files already stored are removed again
  const frozen: { doc: SignDocumentRow; path: string; sha256: string }[] = [];
  let bytes = 0;
  try {
    for (const d of docs) {
      const f = await freezeForSend(ctx, d, w);
      frozen.push({ doc: d, path: f.path, sha256: f.sha256 });
      bytes += f.size;
      if (bytes > ENVELOPE_MAX_BYTES) throw new SignError("envelope_too_big", `The documents of a document collection can be up to ${Math.round(ENVELOPE_MAX_BYTES / (1024 * 1024))} MB in all.`, 413);
    }
  } catch (err) {
    await removeFiles(ctx.admin, frozen.map((f) => f.path));
    throw err;
  }

  // A person signs only the documents on which a field is assigned to them: their rows on the others are left off, and each person's
  // anchor (the row that carries their link) moves to their first remaining document. The list is written again for that, and put back as
  // it was if the database then refuses the send, so nothing the sender prepared is lost.
  const { dropped, keep } = pruneRows(docs, signers);
  const before = peopleFromRows(signers);
  if (dropped.length > 0) {
    try {
      await writeSigners(ctx, env, docs, peopleFromRows(keep));
    } catch (err) {
      await removeFiles(ctx.admin, frozen.map((f) => f.path));
      await writeSigners(ctx, env, docs, before).catch(() => undefined);
      throw err;
    }
  }

  const { data, error } = await ctx.admin.rpc("sign_send_envelope", {
    p_envelope: envelopeId,
    p_docs: frozen.map((f) => ({ document_id: f.doc.id, base_path: f.path, base_sha256: f.sha256, page_count: f.doc.page_count })),
    p_expires_at: expiresAt.toISOString(),
    p_actor: ctx.userId,
  });
  if (error || !data) {
    await removeFiles(ctx.admin, frozen.map((f) => f.path));
    if (dropped.length > 0) await writeSigners(ctx, env, docs, before).catch(() => undefined);
    raiseDatabaseError(error, "send envelope");
  }
  forgetAccountUsage(ctx.accountId);

  const result = data as { reference: string | null; invited: Invitation[] };
  const sentDocs: SignDocumentRow[] = frozen.map((f) => ({ ...f.doc, status: "sent", expires_at: expiresAt.toISOString(), base_path: f.path, base_sha256: f.sha256 }));
  const sentEnvelope: SignEnvelopeRow = { ...env, status: "sent", expires_at: expiresAt.toISOString(), sent_at: now.toISOString() };
  for (const d of sentDocs) await emitSignEvent(ctx, d, "sent"); // the automation trigger and the webhook, per document; never throws
  const invited = await deliverEnvelopeInvitations(ctx, sentEnvelope, sentDocs, result.invited ?? [], { w });
  return {
    envelopeId,
    reference: result.reference ?? env.reference,
    expiresAt: expiresAt.toISOString(),
    documents: sentDocs.map((d) => ({ id: d.id, title: d.title, reference: d.reference, position: d.envelope_position ?? 0 })),
    invited,
  };
}

// ---- after sending --------------------------------------------------------------------------------

/**
 * Cancel the envelope: every document that is still open, together, with the reason on each. Only while no document is fully signed (the
 * database holds the same line); after that the people can still finish or the envelope expires.
 */
export async function voidEnvelope(ctx: SignCtx, envelopeId: string, reason: string | null): Promise<void> {
  const env = await loadEnvelope(ctx, envelopeId);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const verdict = canVoidEnvelope(docs.map((d) => d.status));
  if (!verdict.ok) {
    if (verdict.reason === "partly_completed") throw new SignError("envelope_partly_completed", "A document of this collection was already signed by everyone, so the collection cannot be cancelled.", 409);
    if (verdict.reason === "already_final") throw new SignError("document_already_final", "This document collection has already finished.", 409);
    throw new SignError("envelope_not_sent", "This document collection has not been sent.", 409);
  }
  const { error } = await ctx.admin.rpc("sign_void_envelope", { p_envelope: envelopeId, p_reason: reason, p_actor: ctx.userId });
  if (error) raiseDatabaseError(error, "void envelope");
  for (const d of docs.filter((x) => x.status === "sent" || x.status === "in_progress")) await emitSignEvent(ctx, { ...d, status: "voided" }, "voided"); // never throws
  await notifyEnvelopeEnded(ctx, { ...env, status: "voided" }, docs, { kind: "voided" });
}

/** The person (by their anchor row, the one that has the link) and the rows of theirs, found through this envelope only. */
async function personOf(ctx: SignCtx, envelopeId: string, anchorId: string) {
  const env = await loadEnvelope(ctx, envelopeId);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const rows = await loadEnvelopeSigners(ctx, docs.map((d) => d.id));
  const mine = groupByParty(rows, docs).get(anchorId);
  const anchor = mine ? anchorOf(mine) : undefined;
  if (!mine || !anchor || anchor.id !== anchorId) throw new SignError("signer_not_found", "That person is not on this collection.", 404);
  return { env, docs, rows, mine, anchor };
}

/** A new link for a person who is waiting; the old one stops working. One message, naming the documents they have not finished. */
export async function resendEnvelopePerson(ctx: SignCtx, envelopeId: string, anchorId: string): Promise<InvitationResult> {
  const { env, docs } = await personOf(ctx, envelopeId, anchorId);
  const { data, error } = await ctx.admin.rpc("sign_envelope_rotate_token", { p_anchor: anchorId, p_actor: ctx.userId, p_reason: "resent" });
  if (error || !data) raiseDatabaseError(error, "resend");
  const [r] = await deliverEnvelopeInvitations(ctx, env, docs, [data as Invitation]);
  return r;
}

/** A reminder is a message with a fresh link, recorded as its own event on each document the person has not finished. */
export async function remindEnvelopePerson(ctx: SignCtx, envelopeId: string, anchorId: string): Promise<InvitationResult> {
  const { env, docs, mine } = await personOf(ctx, envelopeId, anchorId);
  const { data, error } = await ctx.admin.rpc("sign_envelope_rotate_token", { p_anchor: anchorId, p_actor: ctx.userId, p_reason: "reminded" });
  if (error || !data) raiseDatabaseError(error, "remind");
  const [r] = await deliverEnvelopeInvitations(ctx, env, docs, [data as Invitation], { reminder: true });
  const at = ctx.now().toISOString();
  const open = mine.filter((s) => s.status === "sent" || s.status === "viewed");
  if (open.length > 0) {
    await ctx.admin.from("sign_signers").update({ last_reminded_at: at, reminder_count: Math.max(...open.map((s) => s.reminder_count)) + 1 }).in("id", open.map((s) => s.id)).eq("account_id", ctx.accountId);
  }
  return r;
}

export interface EnvelopeRecipientChange {
  fullName: string;
  email: string;
  phone?: string | null;
  channel?: "email" | "whatsapp";
}

/**
 * A different person for someone who has signed nothing yet, on all their documents at once: a new link goes to the new address and the
 * new person agrees for themselves. A person who has signed one of the documents cannot be replaced (the database refuses).
 */
export async function changeEnvelopeRecipient(ctx: SignCtx, envelopeId: string, anchorId: string, change: EnvelopeRecipientChange): Promise<InvitationResult> {
  const { env, docs, rows, mine } = await personOf(ctx, envelopeId, anchorId);
  if (!change.fullName.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(change.email.trim())) throw new SignError("signer_details", "Enter a full name and a valid email.", 400);
  const email = change.email.trim().toLowerCase();
  // one human, one place on the envelope: two entries would be two links
  const own = new Set(mine.map((s) => s.id));
  if (rows.some((s) => !own.has(s.id) && s.email.trim().toLowerCase() === email)) throw new SignError("already_on_document", "That person is already on this collection.", 400);
  const { data, error } = await ctx.admin.rpc("sign_envelope_change_recipient", { p_anchor: anchorId, p_name: change.fullName, p_email: change.email, p_phone: change.phone ?? "", p_channel: change.channel ?? null, p_actor: ctx.userId });
  if (error || !data) raiseDatabaseError(error, "change recipient");
  const brief = data as Invitation;
  // a person whose step has not begun has no link yet: the details changed and nothing is sent
  if (!brief.token) return { signerId: anchorId, name: brief.name, roleKey: brief.role_key, delivery: { channel: brief.channel, status: "sent" }, notInvitedYet: true };
  const [r] = await deliverEnvelopeInvitations(ctx, env, docs, [brief]);
  return r;
}

/** Give everyone more time: the same new expiry on every document that is still open, and on the envelope. */
export async function extendEnvelopeExpiry(ctx: SignCtx, envelopeId: string, requested: unknown): Promise<{ expiresAt: string }> {
  const env = await loadEnvelope(ctx, envelopeId);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const open = docs.filter((d) => d.status === "sent" || d.status === "in_progress");
  if (open.length === 0) throw new SignError("document_not_open", "Only a document collection that is waiting for signatures can be given more time.", 409);
  let expiresAt = "";
  for (const d of open) expiresAt = (await extendExpiry(ctx, d.id, requested, { viaEnvelope: true })).expiresAt;
  await ctx.admin.from("sign_envelopes").update({ expires_at: expiresAt }).eq("id", env.id).eq("account_id", ctx.accountId);
  return { expiresAt };
}

/**
 * Delete an envelope: a draft with its drafts, or a completed one once every document's retention date has passed (the database holds the
 * same line for each document). Anything else that was sent is voided, never deleted.
 */
export async function deleteEnvelope(ctx: SignCtx, envelopeId: string): Promise<void> {
  const env = await loadEnvelope(ctx, envelopeId);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const now = ctx.now().getTime();
  if (env.status === "draft") {
    await assertMayEditDraft(ctx, env);
    for (const d of docs) await deleteDraft(ctx, d.id, { viaEnvelope: true });
  } else if (docs.length > 0 && docs.every((d) => d.status === "completed")) {
    const held = docs.find((d) => !d.retain_until || new Date(d.retain_until).getTime() > now);
    if (held) {
      const until = held.retain_until ? new Date(held.retain_until) : null;
      throw new SignError("document_retained", until ? `This signed document collection is kept until ${until.toISOString().slice(0, 10)} and cannot be deleted before then.` : "This signed document collection is kept and cannot be deleted.", 409, [{ code: "document_retained", detail: until?.toISOString() ?? "" }]);
    }
    for (const d of docs) await deleteDocument(ctx, d.id, { viaEnvelope: true });
  } else {
    throw new SignError("envelope_not_deletable", "Only a draft can be deleted. Cancel a document collection that was sent.", 409);
  }
  const { error } = await ctx.admin.from("sign_envelopes").delete().eq("id", envelopeId).eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "delete envelope");
}

// ---- when the last document completes -------------------------------------------------------------

/**
 * Called after a document of an envelope was sealed. When it was the last, the database completes the envelope (once: the one call that
 * claims it gets the message) and each person and the sender get ONE message with every signed copy. Never throws.
 */
export async function settleEnvelope(ctx: SignCtx, envelopeId: string): Promise<void> {
  try {
    const { data, error } = await ctx.admin.rpc("sign_envelope_settle", { p_envelope: envelopeId });
    if (error) {
      console.error("[sign] could not settle the envelope:", envelopeId, error.message);
      return;
    }
    if (!(data as { completed?: boolean } | null)?.completed) return;
    const [env, docs] = await Promise.all([loadEnvelope(ctx, envelopeId), loadEnvelopeDocuments(ctx, envelopeId)]);
    const files: CopyFile[] = [];
    for (const d of docs) {
      if (!d.final_path) continue;
      // migration 178: a document sealed from then on has its certificate as a file of its own, which goes on the same messages (an older one has it inside the signed file)
      const certificate = await certificateOf(ctx, d);
      files.push({ bytes: await getFile(ctx.admin, d.final_path, ctx.accountId), filename: signedFileName(d), documentId: d.id, ...(certificate ? { certificate } : {}) });
    }
    await notifyEnvelopeCompleted(ctx, env, docs, files);
  } catch (err) {
    console.error("[sign] could not tell the people the envelope is complete:", envelopeId, err instanceof Error ? err.message : err);
  }
}

/** The status an envelope reads as, from its documents (the database keeps the same rule in a trigger). */
export const statusOf = (docs: readonly { status: SignDocumentRow["status"] }[]) => deriveEnvelopeStatus(docs.map((d) => d.status));

/** How long a manual reminder to the same person is held back (the screen keeps it, as for a document). */
export const ENVELOPE_REMIND_GAP_MS = REMIND_GAP_MS;
