// ============================================================
// Sealing: when everyone has signed, the sealing job builds the final file. It takes a document with
// a lease (so two workers never share one), writes every signer's answers onto the file that was sent,
// appends the certificate pages, seals it with the workspace's certificate, stores it with its
// SHA-256, and only then lets the database mark the document completed. Any failure leaves the
// document in "sealing" with the reason recorded; the job tries again after the lease, and after five
// attempts the document is marked failed for a person to look at.
// ============================================================

import { certificateLabels, eventSentence } from "../certificate-words";
import { boundPlacements, boundValues, pick, type FormDefinition } from "../forms";
import { isDelegate, nameResolver, stepGroups } from "../forward";
import { notifyCompleted } from "./outcome";
import { emitSignEvent } from "./outbound";
import { envelopeCertificateBlock } from "../envelopes";
import type { CertificateData, CertificateEnvelope } from "../pdf/types";
import { answerFields } from "../pdf/stamp";
import { appendCertificate } from "../pdf/certificate";
import { markTestPages } from "../pdf/testmark";
import { sealPdf } from "../pdf/seal";
import { stampFields } from "../pdf/stamp";
import { sha256Hex } from "../pdf/load";
import { verifyLink } from "../notify";
import { decodeImageDataUrl, type StoredAnswer } from "../rules";
import { documentPath, getFile, putFile, removeFiles } from "../storage";
import type { FieldValue, FieldValues, PlacedField } from "../pdf/types";
import { isFormMode, type SignDocumentRow, type SignLocale, type SignSignerRow } from "../types";
import { CERTIFICATE_HOLD_CODES, sealingCertificate } from "./certificates";
import { loadDocument, loadSenderAndWorkspace, loadSettings, loadSigners, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";
import { loadEnvelope, loadEnvelopeDocuments } from "./envelope-data";
import { settleEnvelope } from "./envelopes";
import { formOf, formState, type AnswerRow } from "./form-state";
import { submissionRecord } from "./record";
import { ANSWER_COLUMNS, openRows, type StoredRow } from "./sensitive";

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
  // the places on the page belong to the signer of the role; a person handed one part of the form only fills that part
  for (const s of signers) if (!isDelegate(s) && !byRole.has(s.role_key)) byRole.set(s.role_key, s);
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
  /** Migration 171: the document is one of an envelope; its certificate lists the documents signed with it. */
  envelope?: CertificateEnvelope | null,
): CertificateData {
  const roleLabel = new Map(doc.roles_snapshot.map((r) => [r.key, r.label]));
  // who a person was at the time: a turn that was forwarded keeps the forwarder's name on what the forwarder did
  const nameAt = nameResolver(signers, events);
  const form = formOf(doc);
  const partTitle = (key: string) => {
    const part = form?.parts.find((p) => p.key === key);
    return part ? pick(part.title, doc.locale) || key : key;
  };
  const history = events
    .map((e) => {
      const text = eventSentence(e.type, doc.locale, { actor: nameAt(e.signer_id, e.created_at) ?? "", sender: info.senderName }, { detail: e.detail, timeZone: info.timeZone, partTitle, mode: doc.mode });
      return text ? { at: new Date(e.created_at), text } : null;
    })
    .filter((e): e is { at: Date; text: string } => !!e);
  // signers in signing order, people who sign in the same step together, each delegate after the person who handed them a part
  const steps = doc.sign_in_order ? stepGroups(signers) : [];
  const stepOf = new Map(steps.flatMap((g) => g.people.map((p) => [p.id, g.step] as const)));
  const holders = signers.filter((s) => !isDelegate(s));
  const listed = (doc.sign_in_order ? steps.flatMap((g) => g.people) : holders).flatMap((s) => [s, ...signers.filter((d) => d.delegated_by === s.id)]);
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
    labels: certificateLabels(doc.locale, doc.mode),
    signers: listed.map((s) => ({
      name: s.full_name,
      email: s.email,
      role: isDelegate(s) ? `${roleLabel.get(s.role_key) ?? s.role_key} (${(s.part_keys ?? []).map(partTitle).join(", ")})` : (roleLabel.get(s.role_key) ?? s.role_key),
      order: doc.sign_in_order && !isDelegate(s) ? stepOf.get(s.id) : undefined,
      status: s.status === "signed" ? "signed" : s.status === "declined" ? "declined" : "pending",
      signedAt: s.signed_at ? new Date(s.signed_at) : undefined,
      ip: s.ip ?? undefined,
      device: deviceOf(s),
      channel: s.channel === "whatsapp" ? "WhatsApp" : "Email",
    })),
    events: history,
    ...(envelope ? { envelope } : {}),
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
    const answersQ = await ctx.admin.from("sign_answers").select(ANSWER_COLUMNS).eq("document_id", documentId).eq("account_id", ctx.accountId);
    if (answersQ.error) raiseDatabaseError(answersQ.error, "load answers");
    const eventsQ = await ctx.admin
      .from("sign_events")
      .select("created_at, type, signer_id, row_hash, detail, doc_seq")
      .eq("document_id", documentId)
      .eq("account_id", ctx.accountId)
      .order("doc_seq", { ascending: true });
    if (eventsQ.error) raiseDatabaseError(eventsQ.error, "load events");

    const form = formOf(doc);
    const opened = openRows((answersQ.data ?? []) as unknown as StoredRow[], documentId);
    // What is sealed. A document to sign: the file that was sent, with what the people entered written on it. A form without a
    // signature (migration 169): a submission record made from the answers, since there is no document to write on. Either way the
    // certificate pages follow and the whole file is sealed below, the same way.
    let body: { bytes: Uint8Array; pageCount: number };
    if (isFormMode(doc)) {
      body = await submissionRecord(doc, signers, opened, (eventsQ.data ?? []) as never, info);
    } else {
      const base = await getFile(ctx.admin, doc.base_path, ctx.accountId);
      const values = valuesFor(doc.fields_snapshot, signers, opened as { signer_id: string; field_key: string; value: StoredAnswer | null }[], form ? { definition: form, locale: doc.locale } : undefined);
      // the places that print the form's answers are stamped with the answers, like any other place a person filled in
      const places = form ? [...answerFields(doc.fields_snapshot), ...boundPlacements(doc.fields_snapshot)] : answerFields(doc.fields_snapshot);
      const stamped = await stampFields(base, places, values, { locale: doc.locale, timeZone: info.timeZone });
      body = { bytes: stamped.bytes, pageCount: doc.page_count ?? 1 };
    }

    // an envelope's documents are sealed one by one, each with its own certificate; the certificate says which documents it was signed with
    let envelope: CertificateEnvelope | null = null;
    if (doc.envelope_id) {
      const [env, siblings] = await Promise.all([loadEnvelope(ctx, doc.envelope_id), loadEnvelopeDocuments(ctx, doc.envelope_id)]);
      envelope = envelopeCertificateBlock(doc.locale, env, siblings, doc.id);
    }
    const data = certificateData(doc, signers, (eventsQ.data ?? []) as never, info, ctx.origin, body.pageCount, envelope);
    const withCertificate = await appendCertificate(body.bytes, data, { locale: doc.locale });
    // a test document (F-10): the pages of the file that was sent carry the TEST mark already (it was put on when it was sent); the certificate pages (and, for a form, the whole submission record) get it now
    const toSeal = doc.test ? (await markTestPages(withCertificate.bytes, { skipPages: isFormMode(doc) ? 0 : body.pageCount })).bytes : withCertificate.bytes;

    const cert = await sealingCertificate(ctx);
    const sealed = await sealPdf(toSeal, cert.p12, cert.passphrase, {
      reason: `${isFormMode(doc) ? "Submitted" : "Signed"} through Halo Doc Sign: ${doc.reference ?? doc.id}`,
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
      name: `${doc.reference ?? "document"}-${isFormMode(doc) ? "record" : "signed"}.pdf`,
      mime: "application/pdf",
      size_bytes: sealed.size,
      sha256: sealed.sha256,
    });
    // the automation trigger and the webhook (never throws); then tell everyone, a message that fails is recorded, never fatal
    await emitSignEvent(ctx, { ...doc, status: "completed", final_path: finalPath, final_sha256: sealed.sha256 }, "completed");
    // a document of an envelope sends no message of its own: when the LAST one is sealed, each person gets ONE message with every signed copy
    if (doc.envelope_id) await settleEnvelope(ctx, doc.envelope_id);
    else await notifyCompleted(ctx, { ...doc, status: "completed", final_path: finalPath, final_sha256: sealed.sha256 }, signers, sealed.bytes);
    return { documentId, status: "completed" };
  } catch (err) {
    if (stored) await removeFiles(ctx.admin, [stored]);
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sign] sealing failed for", documentId, message);
    // a certificate that cannot be used is not a fault of the document: it waits for a valid one, keeping its attempts
    const waitsForCertificate = err instanceof SignError && CERTIFICATE_HOLD_CODES.has(err.code);
    await ctx.admin.rpc(waitsForCertificate ? "sign_hold_sealing" : "sign_fail_sealing", { p_document: documentId, p_error: message.slice(0, 400) });
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
