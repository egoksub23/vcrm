// ============================================================
// Doc Sign for the public API (/api/v1/sign): what an integrator's backend does, built from the same
// services the screens use (a draft from a template, its signers, send, void, remind, the files). This
// file only orders those calls and adds what an unattended caller needs:
//
//   - one call that makes a document and sends it, all or nothing: a draft that could not be sent is
//     deleted, so a retry starts clean;
//   - a caller-chosen `reference` as the idempotency key: the same reference never makes a second
//     document (the unique (account_id, reference) of sign_documents decides a race);
//   - reads that never include a link, token, code, IP address or device.
//
// Every read and write is scoped to ctx.accountId, like the services it calls.
// ============================================================

import { buildPage, keysetFilter, type ListParams } from "@/lib/api/v1/pagination";

import { remindHeldUntil } from "../defaults";
import type { Issue } from "../rules";
import { belongsToAccount, getFile, safeFileName } from "../storage";
import type { DeliveryStatus } from "../notify";
import type { SignChannel, SignCopyRecipientRow, SignDocumentRow, SignSignerRow, SignerKind } from "../types";
import { loadDocument, loadSigners, logEvent, type SignCtx } from "./context";
import { listCopyRecipients, setCopyRecipients } from "./copy-recipients";
import { SignError, raiseDatabaseError } from "./errors";
import { createDraftFromTemplate, deleteDraft, setSigners, updateDraft, type DraftPatch } from "./drafts";
import { formOf } from "./form-state";
import { canSeeDocument, documentListScope } from "./privacy";
import { loadProgress } from "./progress";
import { remindSigner, sendDocument, voidDocument, type InvitationResult } from "./send";

// ---- shapes -------------------------------------------------------------------------------------

export interface ApiSignerInput {
  roleKey: string;
  fullName: string;
  email: string;
  phone: string | null;
  channel: SignChannel;
  orderNo: number | null;
}

export interface ApiCreateInput {
  templateId: string;
  reference: string | null;
  title: string | null;
  contactId: string | null;
  signers: ApiSignerInput[];
  /** People who receive the signed copy when everyone has signed (not signers: no link, no turn). Up to 10. */
  copyTo?: { fullName: string; email: string }[];
  mergeValues: Record<string, string>;
  message: string | null;
  locale: "en" | "ms" | "zh" | "ko" | null;
  expiresInDays: number | null;
  signInOrder: boolean | null;
  codeRequired: boolean | null;
  send: boolean;
}

/** Whether an invitation reached its person. Never the link: the caller reminds again instead. */
export interface ApiInvitation {
  signerId: string;
  roleKey: string;
  channel: SignChannel;
  status: DeliveryStatus;
}

export interface DocumentBundle {
  document: SignDocumentRow;
  signers: SignSignerRow[];
  templateId: string | null;
  /** The people who receive a copy of the signed document (a document of a collection has none of its own). */
  copies?: SignCopyRecipientRow[];
}

export interface CreateOutcome extends DocumentBundle {
  /** The reference was already used: this is the document it made the first time, and nothing was created. */
  replay: boolean;
  invitations: ApiInvitation[];
}

const toInvitation = (r: InvitationResult): ApiInvitation => ({ signerId: r.signerId, roleKey: r.roleKey, channel: r.delivery.channel, status: r.delivery.status });

// ---- small reads ---------------------------------------------------------------------------------

async function templateIdOf(ctx: SignCtx, versionId: string | null): Promise<string | null> {
  if (!versionId) return null;
  const { data, error } = await ctx.admin.from("sign_template_versions").select("template_id").eq("id", versionId).eq("account_id", ctx.accountId).maybeSingle();
  if (error) raiseDatabaseError(error, "load template version");
  return (data as { template_id: string } | null)?.template_id ?? null;
}

async function findByReference(ctx: SignCtx, reference: string): Promise<SignDocumentRow | null> {
  const { data, error } = await ctx.admin.from("sign_documents").select("*").eq("account_id", ctx.accountId).eq("reference", reference).maybeSingle();
  if (error) raiseDatabaseError(error, "find document by reference");
  const found = (data as SignDocumentRow | null) ?? null;
  // a private document is never handed back to a key (the reference reads as unused; the unique index then refuses a second one)
  return found && (await canSeeDocument(ctx, found)) ? found : null;
}

/** One document with its people. A document of another workspace is "not found", exactly like a missing one. */
export async function loadBundle(ctx: SignCtx, documentId: string): Promise<DocumentBundle> {
  const document = await loadDocument(ctx, documentId);
  const [signers, templateId, copies] = await Promise.all([
    loadSigners(ctx, documentId),
    templateIdOf(ctx, document.template_version_id),
    document.envelope_id ? Promise.resolve([] as SignCopyRecipientRow[]) : listCopyRecipients(ctx, { documentId }),
  ]);
  return { document, signers, templateId, copies };
}

// ---- create ---------------------------------------------------------------------------------------

const issue = (code: string, extra: Partial<Issue> = {}): Issue => ({ code, ...extra });

/** Check the people and values against the template the draft was made from. Throws a 400 listing every problem. */
function checkAgainstTemplate(doc: SignDocumentRow, input: ApiCreateInput): { kinds: SignerKind[]; mergeValues: Record<string, string> } {
  const issues: Issue[] = [];
  const roleKinds = new Map(doc.roles_snapshot.map((r) => [r.key, r.kind]));
  const kinds: SignerKind[] = input.signers.map((s, i) => {
    const kind = roleKinds.get(s.roleKey);
    if (!kind) issues.push(issue("unknown_role", { field: `signers[${i}].role_key`, role: s.roleKey, detail: [...roleKinds.keys()].join(", ") }));
    return kind ?? "signer";
  });

  const mergeKeys = new Map<string, boolean>();
  for (const f of doc.fields_snapshot) if (f.merge) mergeKeys.set(f.merge, (mergeKeys.get(f.merge) ?? false) || f.required);
  for (const key of Object.keys(input.mergeValues)) {
    if (!mergeKeys.has(key)) issues.push(issue("unknown_merge_key", { field: `merge_values.${key}`, detail: [...mergeKeys.keys()].join(", ") }));
  }
  for (const [key, required] of mergeKeys) {
    if (required && !input.mergeValues[key]) issues.push(issue("merge_value_missing", { field: `merge_values.${key}` }));
  }
  if (issues.length) throw new SignError("invalid_request", "Some of the details do not match this template. See `issues`.", 400, issues);
  return { kinds, mergeValues: input.mergeValues };
}

async function discardDraft(ctx: SignCtx, documentId: string): Promise<void> {
  try {
    await deleteDraft(ctx, documentId);
  } catch {
    // it was sent after all, or is already gone: nothing to clean up
  }
}

/** A reference that already has a document: hand that document back, unless it was made from another template. */
async function replayOf(ctx: SignCtx, existing: SignDocumentRow, input: ApiCreateInput): Promise<CreateOutcome> {
  const bundle = await loadBundle(ctx, existing.id);
  if (bundle.templateId && bundle.templateId !== input.templateId) {
    throw new SignError("reference_conflict", "That reference was already used for a document made from a different template.", 409);
  }
  return { ...bundle, replay: true, invitations: [] };
}

/**
 * Make a document from a template, set who signs and what is filled in, and send it unless `send` is false.
 * All or nothing: when any step fails the draft is deleted. A reference that was used before returns that
 * document (`replay: true`) and creates nothing.
 */
export async function createDocumentForApi(ctx: SignCtx, input: ApiCreateInput): Promise<CreateOutcome> {
  if (input.reference) {
    const existing = await findByReference(ctx, input.reference);
    if (existing) return replayOf(ctx, existing, input);
  }

  let draft: SignDocumentRow;
  try {
    draft = await createDraftFromTemplate(ctx, { templateId: input.templateId, title: input.title, contactId: input.contactId, reference: input.reference });
  } catch (err) {
    // two calls with one reference at the same moment: the database let one in
    if (err instanceof SignError && err.code === "reference_in_use" && input.reference) {
      const existing = await findByReference(ctx, input.reference);
      if (existing) return replayOf(ctx, existing, input);
    }
    throw err;
  }

  let invitations: ApiInvitation[] = [];
  try {
    const { kinds, mergeValues } = checkAgainstTemplate(draft, input);
    const patch: DraftPatch = {};
    if (input.message !== null) patch.message = input.message;
    if (input.locale !== null) patch.locale = input.locale;
    if (input.expiresInDays !== null) patch.expiresAt = new Date(ctx.now().getTime() + input.expiresInDays * 86_400_000).toISOString();
    if (input.signInOrder !== null) patch.signInOrder = input.signInOrder;
    if (input.codeRequired !== null) patch.codeRequired = input.codeRequired;
    if (Object.keys(mergeValues).length > 0) patch.mergeValues = mergeValues;
    if (Object.keys(patch).length > 0) await updateDraft(ctx, draft.id, patch);

    await setSigners(
      ctx,
      draft.id,
      input.signers.map((s, i) => ({ roleKey: s.roleKey, kind: kinds[i], fullName: s.fullName, email: s.email, phone: s.phone, channel: s.channel, orderNo: s.orderNo ?? i + 1 })),
    );
    // the people who receive a copy are part of the same create, so a replay of the reference finds them there
    if (input.copyTo && input.copyTo.length > 0) await setCopyRecipients(ctx, { documentId: draft.id }, input.copyTo);
    if (input.send) invitations = (await sendDocument(ctx, draft.id)).invited.map(toInvitation);
  } catch (err) {
    await discardDraft(ctx, draft.id);
    throw err;
  }
  return { ...(await loadBundle(ctx, draft.id)), replay: false, invitations };
}

/** Send a draft that was made with `send: false`. */
export async function sendDraftForApi(ctx: SignCtx, documentId: string): Promise<CreateOutcome> {
  const result = await sendDocument(ctx, documentId);
  return { ...(await loadBundle(ctx, documentId)), replay: false, invitations: result.invited.map(toInvitation) };
}

// ---- void and remind -------------------------------------------------------------------------------

/**
 * Cancel a document that has not finished. A document that is already cancelled answers as it is (so a
 * retry is harmless); one that completed, expired or was declined is a 409.
 */
export async function voidForApi(ctx: SignCtx, documentId: string, reason: string): Promise<DocumentBundle> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "voided") {
    if (doc.status !== "draft" && doc.status !== "sent" && doc.status !== "in_progress") {
      throw new SignError("document_not_open", "This document can no longer be cancelled.", 409);
    }
    await voidDocument(ctx, documentId, reason);
  }
  return loadBundle(ctx, documentId);
}

export interface RemindResult {
  invitations: ApiInvitation[];
  /** People left out because a reminder went to them less than a day ago, with when they can be reminded again. */
  held: { signerId: string; retryAt: string }[];
}

/**
 * Remind the people who have not finished. One person (`signerId`) is strict: a 409 when they cannot be
 * reminded (not invited, finished, or reminded within the last 24 hours, `remind_too_soon`). With no
 * `signerId`, everyone who can be reminded now is, and the rest are reported; nobody eligible is a 409.
 * Either way a fresh link replaces the old one, as for a reminder from the screen.
 */
export async function remindForApi(ctx: SignCtx, documentId: string, signerId: string | null): Promise<RemindResult> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "sent" && doc.status !== "in_progress") throw new SignError("document_not_open", "Only a document that is waiting for signatures can be reminded.", 409);
  const signers = await loadSigners(ctx, documentId);
  const now = ctx.now();
  const open = (s: SignSignerRow) => s.status === "sent" || s.status === "viewed";

  if (signerId) {
    const s = signers.find((x) => x.id === signerId);
    if (!s) throw new SignError("signer_not_found", "That person is not on this document.", 404);
    if (!open(s)) throw new SignError("signer_not_open", "That person has already finished or has not been invited yet.", 409);
    const until = remindHeldUntil(s.last_reminded_at, now);
    if (until) throw new SignError("remind_too_soon", `A reminder went to this person less than a day ago. Try again after ${until.toISOString()}.`, 409);
    return { invitations: [toInvitation(await remindSigner(ctx, documentId, s.id))], held: [] };
  }

  const waiting = signers.filter(open);
  const held: RemindResult["held"] = [];
  const due: SignSignerRow[] = [];
  for (const s of waiting) {
    const until = remindHeldUntil(s.last_reminded_at, now);
    if (until) held.push({ signerId: s.id, retryAt: until.toISOString() });
    else due.push(s);
  }
  if (due.length === 0) {
    throw new SignError(waiting.length === 0 ? "nobody_to_remind" : "remind_too_soon", waiting.length === 0 ? "Nobody on this document is waiting to be reminded." : "Everyone waiting was reminded less than a day ago.", 409);
  }
  const invitations: ApiInvitation[] = [];
  for (const s of due) invitations.push(toInvitation(await remindSigner(ctx, documentId, s.id)));
  return { invitations, held };
}

// ---- files ------------------------------------------------------------------------------------------

export const FILE_KINDS = ["signed", "certificate", "original"] as const;
export type ApiFileKind = (typeof FILE_KINDS)[number];

export interface ApiFile {
  bytes: Uint8Array;
  mime: string;
  filename: string;
  sha256: string | null;
}

/**
 * The bytes of a file of a document. The signed copy exists only once the document is completed, and only
 * then is it ever handed out: both the status and the stored path are checked. Opening it is recorded.
 * The certificate is the last pages of the signed copy, not a file of its own.
 */
export async function fileForApi(ctx: SignCtx, documentId: string, kind: ApiFileKind): Promise<ApiFile> {
  const doc = await loadDocument(ctx, documentId);
  const stem = safeFileName(doc.reference ?? doc.title, "document");
  if (kind === "certificate") {
    throw new SignError("no_separate_certificate", "The certificate is the last pages of the signed copy. Download kind=signed.", 404);
  }
  if (kind === "signed") {
    if (doc.status !== "completed" || !doc.final_path || !doc.final_sha256) throw new SignError("not_completed", "The signed copy is available once everyone has signed and the document is completed.", 409);
    if (!belongsToAccount(doc.final_path, ctx.accountId)) throw new SignError("no_final_file", "This document has no signed copy.", 404);
    const bytes = await getFile(ctx.admin, doc.final_path, ctx.accountId);
    await logEvent(ctx, documentId, "downloaded", { actor: "user", userId: ctx.userId, detail: { kind: "final" } });
    // (for a form without a signature the signed copy is the sealed submission record)
    return { bytes, mime: "application/pdf", filename: `${stem}-${doc.mode === "form" ? "record" : "signed"}.pdf`, sha256: doc.final_sha256 };
  }
  if (!doc.original_path) throw new SignError("no_original_file", "This document has no separate original file.", 404);
  const mime = doc.original_type ?? "application/octet-stream";
  const ext = mime.includes("wordprocessingml") ? "docx" : mime.includes("msword") ? "doc" : mime.startsWith("image/") ? mime.slice(6).replace("jpeg", "jpg") : "pdf";
  return { bytes: await getFile(ctx.admin, doc.original_path, ctx.accountId), mime, filename: `${stem}-original.${ext}`, sha256: doc.original_sha256 };
}

// ---- progress (documents with a form) -----------------------------------------------------------------

export interface ApiProgress {
  roleKey: string;
  percent: number;
  lastActivityAt: string | null;
  parts: { key: string; title: string; state: string; done: number; total: number }[];
}

/** Where each role stands in each part of a form, without the answers. Null for a document with no form. */
export async function progressForApi(ctx: SignCtx, doc: SignDocumentRow): Promise<ApiProgress[] | null> {
  if (!formOf(doc)) return null;
  try {
    const p = await loadProgress(ctx, doc.id);
    return p.roles.map((r) => ({
      roleKey: r.roleKey,
      percent: r.percent,
      lastActivityAt: r.lastActivityAt,
      parts: r.parts.map((x) => ({ key: x.key, title: (x.title[doc.locale as keyof typeof x.title] || x.title.en || x.key) as string, state: x.state, done: x.done, total: x.total })),
    }));
  } catch (err) {
    console.error("[sign] api: could not load form progress:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---- lists ------------------------------------------------------------------------------------------

export const LIST_COLUMNS =
  "id, reference, title, status, mode, template_version_id, contact_id, envelope_id, locale, sign_in_order, code_required, expires_at, sent_at, completed_at, final_sha256, void_reason, page_count, created_at, updated_at";

export type ListedDocument = Pick<
  SignDocumentRow,
  | "id" | "reference" | "title" | "status" | "mode" | "template_version_id" | "contact_id" | "envelope_id" | "locale" | "sign_in_order" | "code_required" | "expires_at" | "sent_at" | "completed_at" | "final_sha256" | "void_reason" | "page_count" | "created_at" | "updated_at"
>;

export interface ListFilters {
  status: string | null;
  contactId: string | null;
  templateId: string | null;
  reference: string | null;
  createdAfter: string | null;
}

/** Template ids and who has signed, for a page of documents, in two queries however long the page is. */
export async function summariesFor(ctx: SignCtx, docs: readonly ListedDocument[]): Promise<{ templateIds: Map<string, string>; counts: Map<string, { total: number; signed: number }> }> {
  const templateIds = new Map<string, string>();
  const counts = new Map<string, { total: number; signed: number }>();
  if (docs.length === 0) return { templateIds, counts };
  const versionIds = [...new Set(docs.map((d) => d.template_version_id).filter((v): v is string => !!v))];
  if (versionIds.length > 0) {
    const v = await ctx.admin.from("sign_template_versions").select("id, template_id").eq("account_id", ctx.accountId).in("id", versionIds);
    if (v.error) raiseDatabaseError(v.error, "list template versions");
    for (const row of (v.data ?? []) as { id: string; template_id: string }[]) templateIds.set(row.id, row.template_id);
  }
  const s = await ctx.admin.from("sign_signers").select("document_id, status").eq("account_id", ctx.accountId).in("document_id", docs.map((d) => d.id));
  if (s.error) raiseDatabaseError(s.error, "list signers");
  for (const row of (s.data ?? []) as { document_id: string; status: string }[]) {
    const c = counts.get(row.document_id) ?? { total: 0, signed: 0 };
    c.total++;
    if (row.status === "signed") c.signed++;
    counts.set(row.document_id, c);
  }
  return { templateIds, counts };
}

/** The version ids of a template of this workspace, to filter documents by template. Empty when it has none or is not theirs. */
async function versionIdsOfTemplate(ctx: SignCtx, templateId: string): Promise<string[]> {
  const { data, error } = await ctx.admin.from("sign_template_versions").select("id").eq("account_id", ctx.accountId).eq("template_id", templateId);
  if (error) raiseDatabaseError(error, "list template versions");
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

export interface ListedPage {
  documents: ListedDocument[];
  nextCursor: string | null;
  templateIds: Map<string, string>;
  counts: Map<string, { total: number; signed: number }>;
}

/** A page of this workspace's documents, newest first, by keyset (see lib/api/v1/pagination.ts). */
export async function listDocumentsForApi(ctx: SignCtx, filters: ListFilters, params: ListParams): Promise<ListedPage> {
  let versionIds: string[] | null = null;
  if (filters.templateId) {
    versionIds = await versionIdsOfTemplate(ctx, filters.templateId);
    if (versionIds.length === 0) return { documents: [], nextCursor: null, templateIds: new Map(), counts: new Map() };
  }
  let q = ctx.admin.from("sign_documents").select(LIST_COLUMNS).eq("account_id", ctx.accountId);
  // a test document (F-10) is the sender's own rehearsal: it is not part of what the API lists
  q = q.neq("test", true);
  // a key never sees a private document (migration 176, service/privacy.ts)
  q = (await documentListScope(ctx)).apply(q);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.contactId) q = q.eq("contact_id", filters.contactId);
  if (filters.reference) q = q.eq("reference", filters.reference);
  if (filters.createdAfter) q = q.gt("created_at", filters.createdAfter);
  if (versionIds) q = q.in("template_version_id", versionIds);
  q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(params.limit + 1);
  const keyset = keysetFilter(params.cursor);
  if (keyset) q = q.or(keyset);
  const { data, error } = await q;
  if (error) raiseDatabaseError(error, "list documents");
  const { items, nextCursor } = buildPage((data ?? []) as unknown as ListedDocument[], params.limit);
  return { documents: items, nextCursor, ...(await summariesFor(ctx, items)) };
}
