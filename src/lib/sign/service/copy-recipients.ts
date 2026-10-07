// ============================================================
// People who RECEIVE A COPY (migration 175). A person on a document, or on a document collection, who does not sign: when everything is signed
// and sealed they get ONE email with the signed PDF attached (the sealed copy holds the certificate pages, so the file is the proof).
//
// They are not signers. They live in their own table (sign_copy_recipients), so nothing that reads the signing list (progress, reminders,
// webhooks, the API's signers, the exports, "x of y signed") ever sees them. A copy recipient of a collection belongs to the collection;
// of a single document, to that document (a document of a collection takes none of its own: the database holds that too).
//
// Added or removed while the target is a draft or open (draft, sent, in progress) by someone who may send (the routes check `sign.send`);
// every call here is scoped to ctx.accountId. Each change is an event on the document's history (on every document of a collection): the
// name and the MASKED address, never the address itself.
// ============================================================

import { COPY_EMAIL_MAX, COPY_EMAIL_RE, COPY_NAME_MAX, copiesWithoutSigners, type CopyInput } from "../copy-list";
import { MAX_COPY_RECIPIENTS } from "../envelopes";
import { maskEmail } from "../forward";
import type { SignCopyRecipientRow, SignDocumentRow, SignEnvelopeRow } from "../types";
import { loadDocument, loadSigners, logEvent, type SignCtx } from "./context";
import { loadEnvelope, loadEnvelopeDocuments, loadEnvelopeSigners } from "./envelope-data";
import { SignError, raiseDatabaseError } from "./errors";
import { assertMayEditDraft, callerOf } from "./privacy";

/** The document or the collection a person receives a copy of. */
export type CopyTarget = { documentId: string } | { envelopeId: string };
const isEnvelope = (t: CopyTarget): t is { envelopeId: string } => "envelopeId" in t;

export type { CopyInput };

/** Targets that can still be completed: a person is added or removed only while it is one of these. */
const OPEN = new Set(["draft", "sent", "in_progress"]);

/** A name and an address, checked as a signer's are, and the address in the form it is kept in (trimmed). */
export function cleanCopyInput(input: CopyInput, index?: number): CopyInput {
  const where = index === undefined ? [] : [{ code: "signer_name", detail: String(index) }];
  const fullName = String(input.fullName ?? "").trim();
  const email = String(input.email ?? "").trim();
  if (!fullName || fullName.length > COPY_NAME_MAX) throw new SignError("copy_name", "Enter a full name for the person who receives a copy.", 400, where);
  if (!COPY_EMAIL_RE.test(email) || email.length > COPY_EMAIL_MAX) throw new SignError("copy_email", "Enter a valid email for the person who receives a copy.", 400, index === undefined ? [] : [{ code: "signer_email", detail: String(index) }]);
  return { fullName, email };
}

/** A list of people as a request carries it: `[{ fullName, email }]`. Anything else is a 400 (what is wrong with a name or an address is said when each is checked). */
export function parseCopyList(raw: unknown): CopyInput[] {
  if (!Array.isArray(raw)) throw new SignError("copy_name", "Send the list of people who receive a copy.", 400);
  return raw.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return { fullName: String(o.fullName ?? o.full_name ?? ""), email: String(o.email ?? "") };
  });
}

/** The target as the services read it: its status, the documents the history is written on, and who signs it (their addresses). */
async function resolve(ctx: SignCtx, target: CopyTarget): Promise<{ status: string; documents: SignDocumentRow[]; reference: string | null; signerEmails: Set<string>; envelope: SignEnvelopeRow | null }> {
  if (isEnvelope(target)) {
    const envelope = await loadEnvelope(ctx, target.envelopeId);
    await assertMayEditDraft(ctx, envelope);
    const documents = await loadEnvelopeDocuments(ctx, target.envelopeId);
    const rows = await loadEnvelopeSigners(ctx, documents.map((d) => d.id));
    return { status: envelope.status, documents, reference: envelope.reference, signerEmails: new Set(rows.map((s) => s.email.trim().toLowerCase())), envelope };
  }
  const doc = await loadDocument(ctx, target.documentId);
  if (doc.envelope_id) throw new SignError("document_in_envelope", "This document is part of a document collection. People who receive a copy are added to the collection.", 409);
  await assertMayEditDraft(ctx, doc);
  const signers = await loadSigners(ctx, doc.id);
  return { status: doc.status, documents: [doc], reference: doc.reference, signerEmails: new Set(signers.map((s) => s.email.trim().toLowerCase())), envelope: null };
}

const column = (target: CopyTarget): "document_id" | "envelope_id" => (isEnvelope(target) ? "envelope_id" : "document_id");
const targetId = (target: CopyTarget): string => (isEnvelope(target) ? target.envelopeId : target.documentId);

/** The people who receive a copy, in the order they were added. A person or a key asks about a target they may see (a private document is "not found" to the rest). */
export async function listCopyRecipients(ctx: SignCtx, target: CopyTarget): Promise<SignCopyRecipientRow[]> {
  if (callerOf(ctx).kind !== "system") {
    try {
      if (isEnvelope(target)) await loadEnvelope(ctx, target.envelopeId);
      else await loadDocument(ctx, target.documentId);
    } catch (err) {
      // a target that is not there, is another workspace's, or is private and not the caller's has no people to show (and the list does not say which of these it is)
      if (err instanceof SignError && err.status === 404) return [];
      throw err;
    }
  }
  const { data, error } = await ctx.admin.from("sign_copy_recipients").select("*").eq(column(target), targetId(target)).eq("account_id", ctx.accountId).order("created_at", { ascending: true }).order("id", { ascending: true });
  if (error) raiseDatabaseError(error, "load copy recipients");
  return (data ?? []) as SignCopyRecipientRow[];
}

async function record(ctx: SignCtx, documents: readonly SignDocumentRow[], reference: string | null, type: "copy_recipient_added" | "copy_recipient_removed", who: { fullName: string; email: string }): Promise<void> {
  for (const d of documents) await logEvent(ctx, d.id, type, { actor: "user", userId: ctx.userId, detail: { name: who.fullName, email: maskEmail(who.email), ...(reference ? { reference } : {}) } });
}

function assertOpen(status: string): void {
  if (!OPEN.has(status)) throw new SignError("copy_not_open", "People can receive a copy until the document is completed. This one is not open any more.", 409);
}

/** Refuse a person who is already on the list or who signs it (they get the signed copy anyway). */
function assertNew(existing: readonly SignCopyRecipientRow[], signerEmails: ReadonlySet<string>, email: string): void {
  const lower = email.toLowerCase();
  if (existing.some((c) => c.email.trim().toLowerCase() === lower)) throw new SignError("copy_duplicate", "That person already receives a copy.", 400);
  if (signerEmails.has(lower)) throw new SignError("copy_is_signer", "That person signs this document, so they get the signed copy anyway.", 400);
}

async function insert(ctx: SignCtx, target: CopyTarget, input: CopyInput): Promise<SignCopyRecipientRow> {
  const { data, error } = await ctx.admin
    .from("sign_copy_recipients")
    .insert({ account_id: ctx.accountId, [column(target)]: targetId(target), full_name: input.fullName, email: input.email, created_by: ctx.userId })
    .select("*")
    .single();
  if (error || !data) raiseDatabaseError(error, "add copy recipient");
  return data as SignCopyRecipientRow;
}

/** Add one person. Refused when the target is not open, when they are on it already (or sign it), and past the tenth. */
export async function addCopyRecipient(ctx: SignCtx, target: CopyTarget, input: CopyInput): Promise<SignCopyRecipientRow> {
  const clean = cleanCopyInput(input);
  const t = await resolve(ctx, target);
  assertOpen(t.status);
  const existing = await listCopyRecipients(ctx, target);
  assertNew(existing, t.signerEmails, clean.email);
  if (existing.length >= MAX_COPY_RECIPIENTS) throw new SignError("copy_limit", `Up to ${MAX_COPY_RECIPIENTS} people can receive a copy.`, 400);
  const row = await insert(ctx, target, clean);
  await record(ctx, t.documents, t.reference, "copy_recipient_added", clean);
  return row;
}

/** Remove one person (found through this target only, so a person of another document or workspace is "not found"). */
export async function removeCopyRecipient(ctx: SignCtx, target: CopyTarget, copyId: string): Promise<void> {
  const t = await resolve(ctx, target);
  assertOpen(t.status);
  const existing = await listCopyRecipients(ctx, target);
  const row = existing.find((c) => c.id === copyId);
  if (!row) throw new SignError("copy_recipient_not_found", "That person was not found.", 404);
  const { error } = await ctx.admin.from("sign_copy_recipients").delete().eq("id", copyId).eq(column(target), targetId(target)).eq("account_id", ctx.accountId);
  if (error) raiseDatabaseError(error, "remove copy recipient");
  await record(ctx, t.documents, t.reference, "copy_recipient_removed", { fullName: row.full_name, email: row.email });
}

/**
 * Make the list of people who receive a copy exactly `list` (the draft screen saves its whole list this way): people not on it yet are
 * added, people no longer on it are removed, and a person whose name changed under the same address is replaced. The same checks as adding
 * one at a time, all made before anything is written.
 */
export async function setCopyRecipients(ctx: SignCtx, target: CopyTarget, list: readonly CopyInput[]): Promise<SignCopyRecipientRow[]> {
  const clean = list.map((c, i) => cleanCopyInput(c, i));
  if (clean.length > MAX_COPY_RECIPIENTS) throw new SignError("copy_limit", `Up to ${MAX_COPY_RECIPIENTS} people can receive a copy.`, 400, [{ code: "too_many_copies", detail: String(MAX_COPY_RECIPIENTS) }]);
  const t = await resolve(ctx, target);
  const existing = await listCopyRecipients(ctx, target);
  const wanted = new Map<string, CopyInput>();
  for (const c of clean) {
    const k = c.email.toLowerCase();
    if (wanted.has(k)) throw new SignError("copy_duplicate", "The same person is on the list twice.", 400);
    if (t.signerEmails.has(k)) throw new SignError("copy_is_signer", "That person signs this document, so they get the signed copy anyway.", 400);
    wanted.set(k, c);
  }
  const have = new Map(existing.map((r) => [r.email.trim().toLowerCase(), r]));
  const drop = existing.filter((r) => {
    const w = wanted.get(r.email.trim().toLowerCase());
    return !w || w.fullName !== r.full_name;
  });
  const add = clean.filter((c) => {
    const r = have.get(c.email.toLowerCase());
    return !r || r.full_name !== c.fullName;
  });
  if (drop.length === 0 && add.length === 0) return existing;
  assertOpen(t.status);
  for (const r of drop) {
    const { error } = await ctx.admin.from("sign_copy_recipients").delete().eq("id", r.id).eq(column(target), targetId(target)).eq("account_id", ctx.accountId);
    if (error) raiseDatabaseError(error, "remove copy recipient");
    // a person who is only renamed is not "removed" in the history: they are added again under the new name
    if (!wanted.has(r.email.trim().toLowerCase())) await record(ctx, t.documents, t.reference, "copy_recipient_removed", { fullName: r.full_name, email: r.email });
  }
  for (const c of add) {
    await insert(ctx, target, c);
    await record(ctx, t.documents, t.reference, "copy_recipient_added", c);
  }
  return listCopyRecipients(ctx, target);
}

/**
 * Put a ready-made list (the one a bulk send or a registration form carries, migration 176) on a document that was just made, through the same rules and the
 * same rows as people added by hand: the people who already sign it are left out (they get the signed copy anyway, and the database refuses the same person
 * as both), the rest are set exactly as listed (so a second run, after a retry, changes nothing). Call it after the signers are written and before sending.
 * Nothing is done for an empty list.
 */
export async function applyCopyList(ctx: SignCtx, documentId: string, list: readonly CopyInput[] | null | undefined): Promise<SignCopyRecipientRow[]> {
  if (!list || list.length === 0) return [];
  const signers = await loadSigners(ctx, documentId);
  const wanted = copiesWithoutSigners(list, signers.map((s) => s.email));
  return setCopyRecipients(ctx, { documentId }, wanted);
}
