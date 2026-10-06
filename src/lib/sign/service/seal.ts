// ============================================================
// Sealing: when everyone has signed, the sealing job builds the final file. It takes a document with
// a lease (so two workers never share one), writes every signer's answers onto the file that was sent,
// appends the certificate pages, seals it with the workspace's certificate, stores it with its
// SHA-256, and only then lets the database mark the document completed. Any failure leaves the
// document in "sealing" with the reason recorded; the job tries again after the lease, and after five
// attempts the document is marked failed for a person to look at.
// ============================================================

import { certificateLabels, eventSentence } from "../certificate-words";
import { boundPlacements, boundValues, type FormDefinition } from "../forms";
import { notifyCompleted } from "./outcome";
import type { CertificateData } from "../pdf/types";
import { answerFields } from "../pdf/stamp";
import { appendCertificate } from "../pdf/certificate";
import { sealPdf } from "../pdf/seal";
import { stampFields } from "../pdf/stamp";
import { sha256Hex } from "../pdf/load";
import { verifyLink } from "../notify";
import { decodeImageDataUrl, type StoredAnswer } from "../rules";
import { documentPath, getFile, putFile, removeFiles } from "../storage";
import type { FieldValue, FieldValues, PlacedField } from "../pdf/types";
import type { SignDocumentRow, SignLocale, SignSignerRow } from "../types";
import { sealingCertificate } from "./certificates";
import { loadDocument, loadSenderAndWorkspace, loadSettings, loadSigners, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { formOf, formState, type AnswerRow } from "./form-state";

/** What a stored answer becomes on the page. */
export function toFieldValue(a: StoredAnswer): FieldValue | null {
  if ("text" in a) return { text: a.text };
  if ("checked" in a) return { checked: a.checked };
  if ("typed" in a) return { typed: a.typed };
  if ("image" in a) {
    const img = decodeImageDataUrl(a.image);
    return img ? { image: { bytes: img.bytes, mime: img.mime } } : null;
  }
  return null;
}

/**
 * The values to write for every answerable field: each signer's answers for the fields of their role,
 * their name on name fields and their signing time on signing-date fields. For a document with a form, what
 * the answers to the form print on the places bound to them (in the document's language) goes on top.
 */
export function valuesFor(
  fields: readonly PlacedField[],
  signers: readonly SignSignerRow[],
  answers: readonly { signer_id: string; field_key: string; value: StoredAnswer | null }[],
  form?: { definition: FormDefinition; locale: SignLocale },
): FieldValues {
  const out: Record<string, FieldValue> = {};
  const byRole = new Map<string, SignSignerRow>();
  for (const s of signers) if (!byRole.has(s.role_key)) byRole.set(s.role_key, s);
  const answerOf = new Map(answers.filter((a) => a.value).map((a) => [`${a.signer_id}:${a.field_key}`, a.value as StoredAnswer]));
  for (const f of answerFields(fields)) {
    const signer = byRole.get(f.role);
    if (!signer) continue;
    if (f.type === "name") {
      out[f.key] = { text: signer.full_name };
    } else if (f.type === "date_signed") {
      if (signer.signed_at) out[f.key] = { at: new Date(signer.signed_at) };
    } else {
      const a = answerOf.get(`${signer.id}:${f.key}`);
      const v = a ? toFieldValue(a) : null;
      if (v) out[f.key] = v;
    }
  }
  if (form) {
    const state = formState(form.definition, signers, answers as unknown as AnswerRow[]);
    Object.assign(out, boundValues(fields, form.definition, state.map, form.locale));
  }
  return out;
}

const deviceOf = (s: SignSignerRow) => s.device ?? undefined;

/** Everything the certificate pages say, from the document, its signers and its audit trail. */
export function certificateData(
  doc: SignDocumentRow,
  signers: readonly SignSignerRow[],
  events: readonly { created_at: string; type: string; signer_id: string | null; row_hash: string; detail: Record<string, unknown> }[],
  info: { workspaceName: string; senderName: string; timeZone: string },
  origin: string,
  pageCount: number,
): CertificateData {
  const nameOf = new Map(signers.map((s) => [s.id, s.full_name]));
  const roleLabel = new Map(doc.roles_snapshot.map((r) => [r.key, r.label]));
  const history = events
    .map((e) => {
      const text = eventSentence(e.type, doc.locale, { actor: e.signer_id ? (nameOf.get(e.signer_id) ?? "") : "", sender: info.senderName }, { detail: e.detail, timeZone: info.timeZone });
      return text ? { at: new Date(e.created_at), text } : null;
    })
    .filter((e): e is { at: Date; text: string } => !!e);
  return {
    title: doc.title,
    reference: doc.reference ?? doc.id,
    workspaceName: info.workspaceName,
    baseSha256: doc.base_sha256 ?? "",
    pageCount,
    chainHead: events.length ? events[events.length - 1].row_hash : "",
    verifyUrl: verifyLink(origin, doc.id),
    sentAt: doc.sent_at ? new Date(doc.sent_at) : undefined,
    completedAt: new Date(),
    timeZone: info.timeZone,
    labels: certificateLabels(doc.locale),
    signers: signers.map((s) => ({
      name: s.full_name,
      email: s.email,
      role: roleLabel.get(s.role_key) ?? s.role_key,
      order: doc.sign_in_order ? s.order_no : undefined,
      status: s.status === "signed" ? "signed" : s.status === "declined" ? "declined" : "pending",
      signedAt: s.signed_at ? new Date(s.signed_at) : undefined,
      ip: s.ip ?? undefined,
      device: deviceOf(s),
      channel: s.channel === "whatsapp" ? "WhatsApp" : "Email",
    })),
    events: history,
  };
}

export interface SealOutcome {
  documentId: string;
  status: "completed" | "retry";
  error?: string;
}

/** Seal one document that this worker has claimed. */
export async function sealDocument(ctx: SignCtx, documentId: string): Promise<SealOutcome> {
  let stored: string | null = null;
  try {
    const doc = await loadDocument(ctx, documentId);
    if (doc.status !== "sealing") return { documentId, status: "completed" };
    if (!doc.base_path) throw new SignError("no_base_file", "The document has no file.", 500);
    const [signers, settings, info] = await Promise.all([loadSigners(ctx, documentId), loadSettings(ctx), loadSenderAndWorkspace(ctx, doc.created_by)]);
    void settings;
    const answersQ = await ctx.admin.from("sign_answers").select("signer_id, field_key, value").eq("document_id", documentId).eq("account_id", ctx.accountId);
    if (answersQ.error) raiseDatabaseError(answersQ.error, "load answers");
    const eventsQ = await ctx.admin
      .from("sign_events")
      .select("created_at, type, signer_id, row_hash, detail, doc_seq")
      .eq("document_id", documentId)
      .eq("account_id", ctx.accountId)
      .order("doc_seq", { ascending: true });
    if (eventsQ.error) raiseDatabaseError(eventsQ.error, "load events");

    const base = await getFile(ctx.admin, doc.base_path, ctx.accountId);
    const form = formOf(doc);
    const values = valuesFor(doc.fields_snapshot, signers, (answersQ.data ?? []) as { signer_id: string; field_key: string; value: StoredAnswer | null }[], form ? { definition: form, locale: doc.locale } : undefined);
    // the places that print the form's answers are stamped with the answers, like any other place a person filled in
    const places = form ? [...answerFields(doc.fields_snapshot), ...boundPlacements(doc.fields_snapshot)] : answerFields(doc.fields_snapshot);
    const stamped = await stampFields(base, places, values, { locale: doc.locale, timeZone: info.timeZone });

    const data = certificateData(doc, signers, (eventsQ.data ?? []) as never, info, ctx.origin, doc.page_count ?? 1);
    const withCertificate = await appendCertificate(stamped.bytes, data, { locale: doc.locale });

    const cert = await sealingCertificate(ctx);
    const sealed = await sealPdf(withCertificate.bytes, cert.p12, cert.passphrase, {
      reason: `Signed through Halo Doc Sign: ${doc.reference ?? doc.id}`,
      name: info.workspaceName,
      location: "",
      signingTime: ctx.now(),
    });

    const finalPath = documentPath(ctx.accountId, documentId, "final", `${sealed.sha256}.pdf`);
    await putFile(ctx.admin, finalPath, sealed.bytes, "application/pdf");
    stored = finalPath;
    // verify what we are about to record: read it back and fingerprint it
    const back = await getFile(ctx.admin, finalPath, ctx.accountId);
    if (sha256Hex(back) !== sealed.sha256) throw new SignError("seal_verify_failed", "The stored file does not match what was sealed.", 500);

    const fin = await ctx.admin.rpc("sign_finish_sealing", { p_document: documentId, p_final_path: finalPath, p_final_sha256: sealed.sha256 });
    if (fin.error) raiseDatabaseError(fin.error, "finish sealing");
    stored = null; // recorded: no longer a leftover

    await ctx.admin.from("sign_document_files").insert({
      account_id: ctx.accountId,
      document_id: documentId,
      kind: "signed",
      path: finalPath,
      name: `${doc.reference ?? "document"}-signed.pdf`,
      mime: "application/pdf",
      size_bytes: sealed.size,
      sha256: sealed.sha256,
    });
    // tell everyone; a message that fails is recorded, never fatal
    await notifyCompleted(ctx, { ...doc, status: "completed", final_path: finalPath, final_sha256: sealed.sha256 }, signers, sealed.bytes);
    return { documentId, status: "completed" };
  } catch (err) {
    if (stored) await removeFiles(ctx.admin, [stored]);
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sign] sealing failed for", documentId, message);
    await ctx.admin.rpc("sign_fail_sealing", { p_document: documentId, p_error: message.slice(0, 400) });
    return { documentId, status: "retry", error: message.slice(0, 200) };
  }
}

/** Claim up to `limit` documents and seal them. */
export async function runSealing(base: Omit<SignCtx, "accountId" | "userId">, limit = 2): Promise<{ claimed: number; completed: number; retry: number }> {
  const { data, error } = await base.admin.rpc("sign_claim_sealing", { p_limit: limit, p_lease_seconds: 300, p_max_attempts: 5 });
  if (error) {
    console.error("[sign] could not claim documents to seal:", error.message);
    return { claimed: 0, completed: 0, retry: 0 };
  }
  const claims = (data ?? []) as { document_id: string; account_id: string }[];
  let completed = 0;
  let retry = 0;
  for (const c of claims) {
    const out = await sealDocument({ ...base, accountId: c.account_id, userId: null }, c.document_id);
    if (out.status === "completed") completed++;
    else retry++;
  }
  return { claimed: claims.length, completed, retry };
}
