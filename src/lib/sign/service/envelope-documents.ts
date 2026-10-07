// ============================================================
// Document collections (the envelopes of migration 171), while still a draft: add documents (files of the sender's own, templates, or both,
// in any number that fits), remove one, and put them in a different order. The documents are made by the same services a document alone is
// made by (see envelopes.ts), the rules about drafts, workspaces and places are the database's own (migrations 171 and 174), and what this
// module adds is the order of the work and keeping the shared signing list sound: a person's row on their FIRST document is the one that
// carries the link, so after a removal or a new order the people are written again by the same function a person is saved with.
//
// Only a draft collection changes, and only a draft document is ever deleted here: a sent, signed or sealed document is never touched.
// ============================================================

import { ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MIN_DOCUMENTS, defaultOrder, peopleFromRows, type OrderEntry } from "../envelopes";
import type { SignDocumentRow, SignEnvelopeRow } from "../types";
import { logEvent, type SignCtx } from "./context";
import { assertMayEditDraft } from "./privacy";
import { deleteDraft } from "./drafts";
import { loadEnvelope, loadEnvelopeDocuments, loadEnvelopeSigners } from "./envelope-data";
import { applyEnvelopeOptions, checkEntries, makeEntryDocuments, setEnvelopeSigners, type EnvelopeUpload } from "./envelopes";
import { SignError, raiseDatabaseError } from "./errors";

export interface AddDocumentsArgs {
  /** Files of the sender's own, converted and checked as for any document. */
  files?: readonly EnvelopeUpload[];
  /** Templates to add (used when there is no `order`), after the files. */
  templateIds?: readonly string[];
  /** The documents to add in the order they are added: files (by their place in `files`) and templates interleaved. */
  order?: readonly OrderEntry[];
}

async function draftEnvelope(ctx: SignCtx, envelopeId: string): Promise<SignEnvelopeRow> {
  const env = await loadEnvelope(ctx, envelopeId);
  if (env.status !== "draft") throw new SignError("envelope_not_draft", "This collection was already sent, so its documents cannot be changed.", 409);
  await assertMayEditDraft(ctx, env);
  return env;
}

/** Write the places 1 to n in the order of `ids` (all the documents of the draft collection, once each), in one step. */
async function writeOrder(ctx: SignCtx, envelopeId: string, ids: readonly string[]): Promise<void> {
  const { error } = await ctx.admin.rpc("sign_envelope_set_order", { p_envelope: envelopeId, p_ids: [...ids] });
  if (error) raiseDatabaseError(error, "set the order of the documents");
}

const inPlace = (docs: readonly SignDocumentRow[]) => docs.every((d, i) => d.envelope_position === i + 1);

/**
 * Write the shared signing list again after the documents changed: the same people and roles, with each person's anchor row on their (new)
 * first document. Nothing to do when nobody was saved yet. A list that is no longer sound is left for the envelope's own checks to name
 * (the screen and Send do), never a reason to undo the change that was asked for.
 */
async function resyncPeople(ctx: SignCtx, envelopeId: string): Promise<void> {
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const rows = await loadEnvelopeSigners(ctx, docs.map((d) => d.id));
  if (rows.length === 0) return;
  const ids = new Set(docs.map((d) => d.id));
  const saved = peopleFromRows(rows).map((p) => ({
    key: p.key,
    fullName: p.fullName,
    email: p.email,
    phone: p.phone,
    channel: p.channel,
    step: p.step,
    roles: Object.fromEntries(Object.entries(p.roles).filter(([documentId]) => ids.has(documentId))),
    incomplete: false,
  }));
  // A person the screen is still filling in (migration 175) has a role on the uploaded documents, with fields assigned to it, but no row. Writing the
  // people again without them would take their role and those fields away, so they are carried through as incomplete, as the screen sends them.
  const roleKeys = docs.filter((d) => !d.template_version_id).flatMap((d) => (d.roles_snapshot ?? []).filter((r) => r.source === "people"));
  const known = new Set(saved.map((p) => p.key));
  const held = new Map<string, string>();
  for (const r of roleKeys) if (!known.has(r.key) && !held.has(r.key)) held.set(r.key, r.label);
  const unfinished = [...held].map(([key, label]) => ({ key, fullName: label, email: "", phone: "", channel: "email" as const, step: 1, roles: {} as Record<string, string>, incomplete: true }));
  // in the order the roles are in, so the colours (and the places) do not move
  const place = (key: string) => {
    const i = roleKeys.findIndex((r) => r.key === key);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const people = [...saved, ...unfinished].sort((a, b) => place(a.key) - place(b.key));
  try {
    await setEnvelopeSigners(ctx, envelopeId, people);
  } catch (err) {
    if (!(err instanceof SignError)) throw err;
    console.error("[sign] could not write the signing list again after the documents changed:", envelopeId, err.code);
  }
}

/** One line in the history of each document of the collection (never throws; the history is not a reason to refuse the change). */
async function logOn(ctx: SignCtx, env: SignEnvelopeRow, docs: readonly SignDocumentRow[], type: string, detail: Record<string, unknown>): Promise<void> {
  for (const d of docs) await logEvent(ctx, d.id, type, { actor: "user", userId: ctx.userId, detail: { envelope_id: env.id, reference: env.reference, ...detail } });
}

/**
 * Add documents to a draft collection, after the ones it has, as many as fit (the collection holds up to six). All or nothing: when one
 * cannot be made, the ones made by this call are deleted again and the collection is as it was. The new documents take the collection's own
 * options (signing order, code, language, message, expiry, reminders) and its contact, ticket and deal, as every document of it does.
 */
export async function addEnvelopeDocuments(ctx: SignCtx, envelopeId: string, args: AddDocumentsArgs): Promise<{ added: SignDocumentRow[]; documents: SignDocumentRow[] }> {
  const env = await draftEnvelope(ctx, envelopeId);
  const uploads = [...(args.files ?? [])];
  const entries: readonly OrderEntry[] = args.order ?? defaultOrder(uploads.length, args.templateIds ?? []);
  if (entries.length === 0) throw new SignError("bad_order", "Choose a file or a template to add.", 400);
  let existing = await loadEnvelopeDocuments(ctx, envelopeId);
  if (existing.length + entries.length > ENVELOPE_MAX_DOCUMENTS) {
    throw new SignError("envelope_full", `A collection holds up to ${ENVELOPE_MAX_DOCUMENTS} documents.`, 409);
  }
  await checkEntries(ctx, entries, uploads.length);
  // the new ones take the places after the last: close any gap first so there is room for the sixth
  if (!inPlace(existing)) {
    await writeOrder(ctx, envelopeId, existing.map((d) => d.id));
    existing = await loadEnvelopeDocuments(ctx, envelopeId);
  }

  const lead = existing[0];
  const link = { contactId: env.contact_id, ticketId: lead?.ticket_id ?? null, dealId: lead?.deal_id ?? null, isPrivate: env.is_private === true };
  const made: SignDocumentRow[] = [];
  try {
    await makeEntryDocuments(ctx, envelopeId, existing.length, entries, uploads, link, made);
    const fresh = await applyEnvelopeOptions(ctx, env, made);
    made.splice(0, made.length, ...fresh);
  } catch (err) {
    for (const d of made) await deleteDraft(ctx, d.id, { viaEnvelope: true }).catch(() => undefined);
    throw err;
  }
  // an uploaded file takes a role from each person who must sign, and the people are on it
  await resyncPeople(ctx, envelopeId);
  const documents = await loadEnvelopeDocuments(ctx, envelopeId);
  for (const d of made) await logEvent(ctx, d.id, "envelope_document_added", { actor: "user", userId: ctx.userId, detail: { envelope_id: env.id, reference: env.reference, position: d.envelope_position ?? 0, count: documents.length } });
  return { added: made, documents };
}

/**
 * Remove a document from a draft collection: the document, a draft, is deleted with its files, and the places of the others close up. A
 * collection keeps at least two documents (delete the whole collection to stop). A document that was sent is never deleted, and a document
 * that is not in this collection (or this workspace) is not found.
 */
export async function removeEnvelopeDocument(ctx: SignCtx, envelopeId: string, documentId: string): Promise<{ documents: SignDocumentRow[] }> {
  const env = await draftEnvelope(ctx, envelopeId);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const doc = docs.find((d) => d.id === documentId);
  if (!doc) throw new SignError("document_not_found", "That document was not found.", 404);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "Only a draft can be removed. Void a document that was sent.", 409);
  if (docs.length <= ENVELOPE_MIN_DOCUMENTS) throw new SignError("envelope_minimum", `A collection keeps at least ${ENVELOPE_MIN_DOCUMENTS} documents. Delete the collection instead.`, 409);

  await deleteDraft(ctx, doc.id, { viaEnvelope: true });
  const rest = docs.filter((d) => d.id !== doc.id);
  if (!inPlace(rest)) await writeOrder(ctx, envelopeId, rest.map((d) => d.id));
  await resyncPeople(ctx, envelopeId);
  await logOn(ctx, env, rest, "envelope_document_removed", { title: doc.title, count: rest.length });
  return { documents: await loadEnvelopeDocuments(ctx, envelopeId) };
}

/** Put the documents of a draft collection in a new order: `ids` is every document of it, once each, first to last. */
export async function reorderEnvelopeDocuments(ctx: SignCtx, envelopeId: string, ids: readonly string[]): Promise<{ documents: SignDocumentRow[] }> {
  const env = await draftEnvelope(ctx, envelopeId);
  const docs = await loadEnvelopeDocuments(ctx, envelopeId);
  const known = new Set(docs.map((d) => d.id));
  if (ids.length !== docs.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
    throw new SignError("bad_order", "The order must name every document of the collection once.", 400);
  }
  const unchanged = inPlace(docs) && ids.every((id, i) => docs[i].id === id);
  if (unchanged) return { documents: docs };
  await writeOrder(ctx, envelopeId, ids);
  await resyncPeople(ctx, envelopeId);
  const documents = await loadEnvelopeDocuments(ctx, envelopeId);
  await logOn(ctx, env, documents, "envelope_reordered", { count: documents.length });
  return { documents };
}
