// ============================================================
// Sensitive answers (F-47), the storage half. A data field marked `sensitive` is never stored as plain text:
// `sealAnswer` turns the answer into a row that holds only ciphertext (`value_enc`, `value` left empty), and
// `openAnswer` / `openRows` turn a stored row back into the answer, in memory, for the code that needs the value:
//
//   the signer's own page (their own answers), the checks that decide whether a form is complete and sound, and the
//   sealing job that prints on the PDF. Nothing else reads a plain value: a sender's screen gets a mask
//   (sensitive-staff.ts), the exports and the public API get no answers at all, write-back never sees one (a sensitive
//   field cannot be mapped to a contact field), and no audit event, notification or log line carries one.
//
// EVERY read of the sign_answers table that wants the answer goes through `ANSWER_COLUMNS` and `openRows`
// (`loadAnswerRows` in form-state.ts is the one reader; sealing opens what it selected). A test scans the source so a new
// reader cannot select `value` without also handling `value_enc`. Every write goes through `sealAnswer`.
//
// What is stored is `encrypt(JSON.stringify({ d: document, k: field key, v: value }))`: the document and the key travel
// inside the ciphertext, so a ciphertext copied onto another row (by someone who can write to the table) is refused when
// it is opened. Encryption is the workspace's key ring (lib/whatsapp/encryption.ts), so rotation re-encrypts it
// with the rest (`sign_answers.value_enc` is in ENCRYPTED_COLUMNS).
// ============================================================

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import { isSensitive, type DataField } from "../forms";
import { SignError } from "./errors";
import type { AnswerRow, AnswerSource } from "./form-state";

/** The columns a reader of sign_answers selects to get an answer. Never select `value` on its own. */
export const ANSWER_COLUMNS = "signer_id, field_key, value, value_enc, source, saved_at";

/** A row of sign_answers as it is stored. */
export interface StoredRow {
  signer_id: string;
  field_key: string;
  value: unknown;
  value_enc?: string | null;
  source?: AnswerSource;
  saved_at?: string | null;
}

/** What to write for one answer: the plain value for an ordinary field, only ciphertext for a sensitive one. */
export interface SealedAnswer {
  value: unknown;
  value_enc: string | null;
  sensitive: boolean;
}

interface Where {
  documentId: string;
  fieldKey: string;
}

/**
 * The columns to store an answer in. `field` is the data field the answer is for (undefined for a placed field of the
 * page, which is never sensitive). The plain value of a sensitive field is returned nowhere in the result.
 */
export function sealAnswer(field: Pick<DataField, "sensitive"> | null | undefined, value: unknown, where: Where): SealedAnswer {
  if (!isSensitive(field)) return { value, value_enc: null, sensitive: false };
  try {
    return { value: null, value_enc: encrypt(JSON.stringify({ d: where.documentId, k: where.fieldKey, v: value })), sensitive: true };
  } catch (err) {
    // no key is configured: the answer is not saved in the clear instead, and nothing of it is in the message
    console.error("[sign] a sensitive answer could not be encrypted:", where.fieldKey, err instanceof Error ? err.message.slice(0, 120) : "failed");
    throw new SignError("sensitive_unavailable", "This answer cannot be saved right now. Try again later.", 503);
  }
}

/** The answer a stored row holds: its plain value, or the decrypted value of a sensitive one. Throws `sensitive_unreadable` if it cannot be read. */
export function openAnswer(row: Pick<StoredRow, "field_key" | "value" | "value_enc">, documentId: string): unknown {
  if (typeof row.value_enc !== "string" || row.value_enc === "") return row.value;
  try {
    const opened = JSON.parse(decrypt(row.value_enc)) as { d?: unknown; k?: unknown; v?: unknown };
    if (opened.d !== documentId || opened.k !== row.field_key) throw new Error("belongs to another answer");
    return opened.v;
  } catch (err) {
    // the reason is logged, never the value (a failed decryption has none to give)
    console.error("[sign] a sensitive answer could not be read:", row.field_key, err instanceof Error ? err.message.slice(0, 120) : "unreadable");
    throw new SignError("sensitive_unreadable", "An answer could not be read. Ask an administrator to check the encryption key.", 500);
  }
}

/** The rows with every sensitive answer opened into `value` (and `value_enc` dropped). Plain values stay in memory only. */
export function openRows(rows: readonly StoredRow[], documentId: string): AnswerRow[] {
  return rows.map((r) => ({ signer_id: r.signer_id, field_key: r.field_key, value: openAnswer(r, documentId), source: r.source, saved_at: r.saved_at }));
}
