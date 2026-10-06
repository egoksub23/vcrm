// ============================================================
// The submission record of a form without a signature (migration 169, F-97), the data half: what the sealing job puts on
// the answer pages of the file it seals (seal.ts calls this when the document's mode is `form`, then appends the certificate
// pages, seals and stores the file exactly as it does for a signed document).
//
// The answers are read as the stored form state (a person handed one part of the form answers that part; the rules that
// decide which parts and fields are shown are the shared module's), written in the document's language, and every
// SENSITIVE answer (forms/sensitive.ts) is printed only as the mask the shared module makes of it, never in full: the
// record is sent to everyone and kept for years. The pictures people drew or uploaded are not printed (the record says one
// was attached); files are listed with their fingerprints.
// ============================================================

import { PRINT_MASK_CHAR, submissionSummary } from "../forms";
import { isDelegate } from "../forward";
import { buildSubmissionRecord } from "../pdf/record";
import type { RecordData } from "../pdf/record";
import { LANGUAGE_NAMES, recordLabels } from "../record-words";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { SignError } from "./errors";
import { formOf, formState, type AnswerRow } from "./form-state";

/** The data the answer pages print. Pure: the caller loaded the rows (sensitive ones opened in memory) and the events. */
export function recordData(
  doc: SignDocumentRow,
  signers: readonly SignSignerRow[],
  rows: readonly AnswerRow[],
  events: readonly { row_hash: string }[],
  info: { workspaceName: string; timeZone: string },
): RecordData {
  const form = formOf(doc);
  if (!form) throw new SignError("no_form", "This document has no form to record.", 500);
  const roleLabel = new Map(doc.roles_snapshot.map((r) => [r.key, r.label]));
  const label = (key: string) => roleLabel.get(key) ?? key;
  const state = formState(form, signers, rows);
  const parts = submissionSummary(form, state.map, doc.locale, { maskChar: PRINT_MASK_CHAR });
  const submitted = signers.filter((s) => s.status === "signed" && s.signed_at).map((s) => new Date(s.signed_at as string).getTime());
  return {
    title: doc.title,
    reference: doc.reference ?? doc.id,
    workspaceName: info.workspaceName,
    // the people who hold a place first; a person handed one part of someone's form is named with their part
    people: [...signers.filter((s) => !isDelegate(s)), ...signers.filter(isDelegate)].map((s) => ({ name: s.full_name, role: label(s.role_key) })),
    submittedAt: submitted.length > 0 ? new Date(Math.max(...submitted)) : new Date(),
    timeZone: info.timeZone,
    chainHead: events.length > 0 ? events[events.length - 1].row_hash : "",
    languageName: LANGUAGE_NAMES[doc.locale] ?? LANGUAGE_NAMES.en,
    parts: parts.map((p) => ({
      title: p.title,
      role: label(p.roleKey),
      rows: p.rows.map((r) => ({ label: r.label, text: r.text, answered: r.answered, sensitive: r.sensitive, picture: r.picture, files: r.files })),
    })),
    labels: recordLabels(doc.locale),
  };
}

/** The answer pages as a PDF, with how many pages they have. */
export async function submissionRecord(
  doc: SignDocumentRow,
  signers: readonly SignSignerRow[],
  rows: readonly AnswerRow[],
  events: readonly { row_hash: string }[],
  info: { workspaceName: string; timeZone: string },
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  return buildSubmissionRecord(recordData(doc, signers, rows, events, info), { locale: doc.locale });
}
