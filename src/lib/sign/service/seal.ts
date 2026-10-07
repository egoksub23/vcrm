// ============================================================
// Sealing: when everyone has signed, the sealing job builds the final file. It takes a document with
// a lease (so two workers never share one), writes every signer's answers onto the file that was sent
// (and the ID line, "Vircle Secure Sign · ID ...", on every page), seals it with the workspace's certificate
// and stores it with its SHA-256. Then it makes the certificate of completion as a PDF of its own (migration
// 178), which names the signed file by that SHA-256, seals it with the same certificate and stores it beside
// the signed file; a workspace that asked for it ALSO gets the certificate pages inside the signed file. Only
// then does the database mark the document completed, with both files recorded in the one statement. Any
// failure (the certificate included) leaves the document in "sealing" with the reason recorded, removes what
// was stored, and the job tries again after the lease; after five attempts the document is marked failed
// for a person to look at.
// ============================================================

import { certificateLabels, eventSentence } from "../certificate-words";
import { boundPlacements, boundValues, pick, type FormDefinition } from "../forms";
import { isDelegate, nameResolver, stepGroups } from "../forward";
import { notifyCompleted } from "./outcome";
import { emitSignEvent } from "./outbound";
import { envelopeCertificateBlock } from "../envelopes";
import type { CertificateCovers, CertificateData, CertificateEnvelope } from "../pdf/types";
import { answerFields } from "../pdf/stamp";
import { appendCertificate, buildCertificate } from "../pdf/certificate";
import { idFooterText } from "../pdf/idfooter";
import { markTestPages } from "../pdf/testmark";
import { sealPdf } from "../pdf/seal";
import { stampFields } from "../pdf/stamp";
import { sha256Hex } from "../pdf/load";
import { verifyLink } from "../notify";
import { decodeImageDataUrl, type StoredAnswer } from "../rules";
import { documentPath, getFile, putFile, removeFiles } from "../storage";
import type { FieldValue, FieldValues, PlacedField } from "../pdf/types";
import { certificateFileName, signedFileName } from "../file-names";
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
  /** Migration 178: a standalone certificate names the sealed file it covers (its name and SHA-256). Absent for the pages embedded in the signed file. */
  covers?: CertificateCovers,
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
    documentId: doc.id,
    ...(covers ? { covers } : {}),
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

/**
 * What went wrong, in one line, for the document's record, the audit trail and the server's log: the kind of error and its code (a missing font
 * file says ENOENT and its path; a refused database call says what was refused) as well as its message, so a stuck document can be diagnosed
 * from the page of the sender without reading the server's log.
 */
export function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // our own errors are written to be read (a certificate that expired says so, with the date): they are kept as they are
  if (err instanceof SignError) return err.message;
  const code = (err as { code?: unknown }).code;
  const named = err.name && err.name !== "Error" ? `${err.name}: ` : "";
  return `${named}${typeof code === "string" && !err.message.includes(code) ? `${code}: ` : ""}${err.message}`;
}

/**
 * Run a step that puts the ID line on pages, and carry on without the line when the step fails: the stamp is the one thing in sealing that may
 * be left off (never the seal, never the answers). A step that fails for a reason of its own fails again without the line, and that error is the
 * one that is reported.
 */
async function withIdFooter<T>(what: string, documentId: string, text: string, run: (idFooter: string | undefined) => Promise<T>): Promise<T> {
  try {
    return await run(text);
  } catch (err) {
    console.error(`[sign] the ID line could not be stamped (${what}) for`, documentId, "- sealing without it:", describeFailure(err));
    return run(undefined);
  }
}

/** Seal one document that this worker has claimed. */
export async function sealDocument(ctx: SignCtx, documentId: string): Promise<SealOutcome> {
  // every file stored by this attempt, so a failure leaves nothing behind (the next attempt makes its own: they carry the seal's own time)
  const stored: string[] = [];
  const startedAt = Date.now();
  try {
    const doc = await loadDocument(ctx, documentId);
    if (doc.status !== "sealing") return { documentId, status: "completed" };
    if (!doc.base_path) throw new SignError("no_base_file", "The document has no file.", 500);
    const [signers, settings, info] = await Promise.all([loadSigners(ctx, documentId), loadSettings(ctx), loadSenderAndWorkspace(ctx, doc.created_by)]);
    const answersQ = await ctx.admin.from("sign_answers").select(ANSWER_COLUMNS).eq("document_id", documentId).eq("account_id", ctx.accountId);
    if (answersQ.error) raiseDatabaseError(answersQ.error, "load answers");
    const eventsQ = await ctx.admin
      .from("sign_events")
      .select("created_at, type, signer_id, row_hash, detail, doc_seq")
      .eq("document_id", documentId)
      .eq("account_id", ctx.accountId)
      .order("doc_seq", { ascending: true });
    if (eventsQ.error) raiseDatabaseError(eventsQ.error, "load events");

    // a document of a collection: the collection it is part of (its certificate lists the documents signed with it, and the ID line on each page names it)
    let envelope: CertificateEnvelope | null = null;
    let collectionReference: string | null = null;
    if (doc.envelope_id) {
      const [env, siblings] = await Promise.all([loadEnvelope(ctx, doc.envelope_id), loadEnvelopeDocuments(ctx, doc.envelope_id)]);
      envelope = envelopeCertificateBlock(doc.locale, env, siblings, doc.id);
      collectionReference = env.reference ?? null;
    }
    // "Vircle Secure Sign · [COL-...] · ID <id>" on every page of the signed file: written with the answers, before the seal and the fingerprint
    const idFooter = idFooterText({ documentId: doc.id, collectionReference });
    const form = formOf(doc);
    const opened = openRows((answersQ.data ?? []) as unknown as StoredRow[], documentId);
    // What is sealed. A document to sign: the file that was sent, with what the people entered written on it. A form without a
    // signature (migration 169): a submission record made from the answers, since there is no document to write on. Either way the
    // file is sealed below, the same way, and the certificate is made after it (a file of its own, and inside the file too when the workspace asks).
    let body: { bytes: Uint8Array; pageCount: number };
    if (isFormMode(doc)) {
      body = await withIdFooter("submission record", documentId, idFooter, (footer) => submissionRecord(doc, signers, opened, (eventsQ.data ?? []) as never, info, footer ? { idFooter: footer } : {}));
    } else {
      const base = await getFile(ctx.admin, doc.base_path, ctx.accountId);
      const values = valuesFor(doc.fields_snapshot, signers, opened as { signer_id: string; field_key: string; value: StoredAnswer | null }[], form ? { definition: form, locale: doc.locale } : undefined);
      // the places that print the form's answers are stamped with the answers, like any other place a person filled in
      const places = form ? [...answerFields(doc.fields_snapshot), ...boundPlacements(doc.fields_snapshot)] : answerFields(doc.fields_snapshot);
      const stamped = await withIdFooter("answers", documentId, idFooter, (footer) => stampFields(base, places, values, { locale: doc.locale, timeZone: info.timeZone, ...(footer ? { idFooter: footer } : {}) }));
      if (stamped.footer && (stamped.footer.failed > 0 || stamped.footer.skipped > 0)) console.warn("[sign] the ID line was left off some pages of", documentId, JSON.stringify(stamped.footer));
      body = { bytes: stamped.bytes, pageCount: doc.page_count ?? 1 };
    }

    const embed = settings.embed_certificate === true;
    let toSeal = body.bytes;
    if (embed) {
      // the workspace asked for the certificate pages inside the signed file as well (the way every document was sealed before migration 178)
      const embedded = certificateData(doc, signers, (eventsQ.data ?? []) as never, info, ctx.origin, body.pageCount, envelope);
      const withCertificate = await withIdFooter("certificate pages", documentId, idFooter, (footer) => appendCertificate(body.bytes, embedded, { locale: doc.locale, ...(footer ? { idFooter: footer } : {}) }));
      toSeal = withCertificate.bytes;
    }
    // a test document (F-10): the pages of the file that was sent carry the TEST mark already (it was put on when it was sent); the pages added at sealing get it now
    // (the certificate pages when they are embedded, and for a form the whole submission record)
    if (doc.test && (embed || isFormMode(doc))) toSeal = (await markTestPages(toSeal, { skipPages: isFormMode(doc) ? 0 : body.pageCount })).bytes;

    const cert = await sealingCertificate(ctx);
    const reason = `${isFormMode(doc) ? "Submitted" : "Signed"} through Vircle Secure Sign: ${doc.reference ?? doc.id}`;
    const sealed = await sealPdf(toSeal, cert.p12, cert.passphrase, { reason, name: info.workspaceName, location: "", signingTime: ctx.now() });

    const finalPath = documentPath(ctx.accountId, documentId, "final", `${sealed.sha256}.pdf`);
    await putFile(ctx.admin, finalPath, sealed.bytes, "application/pdf");
    stored.push(finalPath);
    // verify what we are about to record: read it back and fingerprint it
    const back = await getFile(ctx.admin, finalPath, ctx.accountId);
    if (sha256Hex(back) !== sealed.sha256) throw new SignError("seal_verify_failed", "The stored file does not match what was sealed.", 500);

    // the certificate of completion as a file of its own: it names the signed file by the fingerprint just made, is sealed with the same certificate,
    // and is stored and read back like the signed file. A failure anywhere here fails the seal (and is retried like any seal failure): the document
    // is not completed without it, because the database is only told once both files are in place.
    const covers: CertificateCovers = { fileName: signedFileName(doc), sha256: sealed.sha256 };
    const standalone = certificateData(doc, signers, (eventsQ.data ?? []) as never, info, ctx.origin, body.pageCount, envelope, covers);
    const built = await buildCertificate(standalone, { locale: doc.locale });
    const certificatePdf = doc.test ? (await markTestPages(built.bytes)).bytes : built.bytes;
    const sealedCertificate = await sealPdf(certificatePdf, cert.p12, cert.passphrase, {
      reason: `Certificate of ${isFormMode(doc) ? "submission" : "completion"} through Vircle Secure Sign: ${doc.reference ?? doc.id}`,
      name: info.workspaceName,
      location: "",
      signingTime: ctx.now(),
    });
    const certificatePath = documentPath(ctx.accountId, documentId, "certificate", `${sealedCertificate.sha256}.pdf`);
    await putFile(ctx.admin, certificatePath, sealedCertificate.bytes, "application/pdf");
    stored.push(certificatePath);
    const certificateBack = await getFile(ctx.admin, certificatePath, ctx.accountId);
    if (sha256Hex(certificateBack) !== sealedCertificate.sha256) throw new SignError("seal_verify_failed", "The stored certificate does not match what was sealed.", 500);

    const fin = await ctx.admin.rpc("sign_finish_sealing", {
      p_document: documentId,
      p_final_path: finalPath,
      p_final_sha256: sealed.sha256,
      p_certificate_path: certificatePath,
      p_certificate_sha256: sealedCertificate.sha256,
    });
    if (fin.error) raiseDatabaseError(fin.error, "finish sealing");
    stored.length = 0; // recorded: no longer leftovers

    await ctx.admin.from("sign_document_files").insert([
      {
        account_id: ctx.accountId,
        document_id: documentId,
        kind: "signed",
        path: finalPath,
        name: signedFileName(doc),
        mime: "application/pdf",
        size_bytes: sealed.size,
        sha256: sealed.sha256,
      },
      {
        account_id: ctx.accountId,
        document_id: documentId,
        kind: "certificate",
        path: certificatePath,
        name: certificateFileName(doc),
        mime: "application/pdf",
        size_bytes: sealedCertificate.size,
        sha256: sealedCertificate.sha256,
      },
    ]);
    const completed = { ...doc, status: "completed" as const, final_path: finalPath, final_sha256: sealed.sha256, certificate_path: certificatePath, certificate_sha256: sealedCertificate.sha256 };
    // the automation trigger and the webhook (never throws); then tell everyone, a message that fails is recorded, never fatal
    await emitSignEvent(ctx, completed, "completed");
    // a document of an envelope sends no message of its own: when the LAST one is sealed, each person gets ONE message with every signed copy
    if (doc.envelope_id) await settleEnvelope(ctx, doc.envelope_id);
    else await notifyCompleted(ctx, completed, signers, sealed.bytes, sealedCertificate.bytes);
    // one line for each document sealed, so the server's log shows that sealing is running and how long it takes
    console.info("[sign] sealed", documentId, `${Date.now() - startedAt} ms`, `${Math.round(sealed.size / 1024)} KB + ${Math.round(sealedCertificate.size / 1024)} KB certificate`);
    return { documentId, status: "completed" };
  } catch (err) {
    if (stored.length > 0) await removeFiles(ctx.admin, stored);
    const message = describeFailure(err);
    // the whole line goes to the server's log (with where it happened); the first 400 characters go onto the document, for its sender to read
    console.error("[sign] sealing failed for", documentId, message, err instanceof Error && err.stack ? `| ${err.stack.split(/\r?\n/).slice(1, 4).map((l) => l.trim()).join(" | ")}` : "");
    // a certificate that cannot be used is not a fault of the document: it waits for a valid one, keeping its attempts
    const waitsForCertificate = err instanceof SignError && CERTIFICATE_HOLD_CODES.has(err.code);
    await ctx.admin.rpc(waitsForCertificate ? "sign_hold_sealing" : "sign_fail_sealing", { p_document: documentId, p_error: message.slice(0, 400) });
    return { documentId, status: "retry", error: message.slice(0, 200) };
  }
}

/** Claim up to `limit` documents and seal them. */
/**
 * The cron's sealing step: claim ONE document at a time and seal it, until the tick's time budget is used up or `max` documents are
 * done. Claiming just before sealing means a lease only starts when the work does (claiming several up front started the lease of the
 * second while the first was still being sealed), and a budget means a heavy document does not hold the tick up for the others. Sealing
 * is CPU-bound on the one event loop, so it stays sequential. At 4 a tick and one tick a minute that is 240 an hour (docs/doc-sign-load-notes.md).
 */
export async function runSealingWithin(
  base: Omit<SignCtx, "accountId" | "userId">,
  opts: { budgetMs?: number; max?: number } = {},
): Promise<SealRun> {
  const budgetMs = opts.budgetMs ?? 20_000;
  const max = opts.max ?? 4;
  const started = Date.now();
  const total: SealRun = { claimed: 0, completed: 0, retry: 0 };
  while (total.claimed < max && Date.now() - started < budgetMs) {
    const one = await runSealing(base, 1);
    if (one.claimed === 0) break;
    total.claimed += one.claimed;
    total.completed += one.completed;
    total.retry += one.retry;
    if (one.errors) total.errors = [...(total.errors ?? []), ...one.errors];
  }
  return total;
}

/** What a sealing run did. `errors` (only when something failed): why, one line for each document that did not seal this time. */
export interface SealRun {
  claimed: number;
  completed: number;
  retry: number;
  errors?: string[];
}

export async function runSealing(base: Omit<SignCtx, "accountId" | "userId">, limit = 2): Promise<SealRun> {
  const { data, error } = await base.admin.rpc("sign_claim_sealing", { p_limit: limit, p_lease_seconds: 300, p_max_attempts: 5 });
  if (error) {
    console.error("[sign] could not claim documents to seal:", error.message);
    return { claimed: 0, completed: 0, retry: 0, errors: [`could not claim documents to seal: ${error.message}`.slice(0, 200)] };
  }
  const claims = (data ?? []) as { document_id: string; account_id: string }[];
  let completed = 0;
  let retry = 0;
  const errors: string[] = [];
  for (const c of claims) {
    const out = await sealDocument({ ...base, accountId: c.account_id, userId: null }, c.document_id);
    if (out.status === "completed") completed++;
    else {
      retry++;
      errors.push(`${c.document_id}: ${out.error ?? "unknown"}`.slice(0, 260));
    }
  }
  return { claimed: claims.length, completed, retry, ...(errors.length > 0 ? { errors } : {}) };
}

/**
 * Seal what is waiting RIGHT NOW, in the background, after the answer to a signer's last signature has gone out (the routes hand this to Next's
 * `after`). The minute job stays the safety net (it also retries and expires); this only makes the signed copy appear within seconds instead of
 * within a minute. It uses the same claim with a lease as the job, so the two never seal one document twice. Best effort: it never throws,
 * and whatever it does not finish the job does.
 */
export async function sealSoon(base: Omit<SignCtx, "accountId" | "userId">, opts: { budgetMs?: number; max?: number } = {}): Promise<SealRun | null> {
  try {
    const run = await runSealingWithin(base, { budgetMs: opts.budgetMs ?? 15_000, max: opts.max ?? 3 });
    if (run.retry > 0) console.error("[sign] sealing right after the last signature did not finish; the job will try again:", (run.errors ?? []).join(" ; "));
    return run;
  } catch (err) {
    console.error("[sign] sealing right after the last signature failed:", describeFailure(err));
    return null;
  }
}
