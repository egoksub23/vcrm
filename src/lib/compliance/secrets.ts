// ============================================================
// Compliance requests: sensitive answers (bank name, account number, account holder, anything a type marks sensitive). SERVER ONLY (the key ring is Node).
//
// What is stored (compliance_requests.data_enc) is `encrypt(JSON.stringify({ r: <request id>, v: { field: text, ... } }))`: the key ring's AES-256-GCM, the
// case's id inside the ciphertext, so a ciphertext copied onto another case is refused when it is opened (the same rule as Secure Sign's sensitive
// answers). `data` (the ordinary answers) never holds one. The browser receives a MASK of each (`•••• 1234`) and the full text only from the reveal
// route (compliance.reveal, rate limited, logged). The re-encryption job (lib/crypto/reencrypt.ts) covers the column.
// ============================================================

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";
import { maskText } from "@/lib/sign/forms/sensitive";

import { ComplianceError } from "./errors";
import type { FieldDef, SensitiveField } from "./types";

export type SensitiveValues = Record<string, string>;

/** Encrypt the sensitive answers of one case. An empty bag stores nothing (null). */
export function sealSensitive(requestId: string, values: SensitiveValues): string | null {
  const keys = Object.keys(values).filter((k) => values[k] !== "");
  if (keys.length === 0) return null;
  const v: SensitiveValues = {};
  for (const k of keys) v[k] = values[k];
  try {
    return encrypt(JSON.stringify({ r: requestId, v }));
  } catch (err) {
    // no key is configured: nothing is saved in the clear instead, and nothing of the value is in the message
    console.error("[compliance] sensitive answers could not be encrypted:", err instanceof Error ? err.message.slice(0, 120) : "failed");
    throw new ComplianceError("encryption_unavailable", "These details cannot be saved right now. Try again later.", 503);
  }
}

/** Decrypt a case's sensitive answers. Throws `encryption_unavailable` (500) if they cannot be read. A null / empty column is an empty bag. */
export function openSensitive(requestId: string, enc: string | null | undefined): SensitiveValues {
  if (typeof enc !== "string" || enc === "") return {};
  try {
    const opened = JSON.parse(decrypt(enc)) as { r?: unknown; v?: unknown };
    if (opened.r !== requestId) throw new Error("belongs to another case");
    const out: SensitiveValues = {};
    if (opened.v && typeof opened.v === "object") for (const [k, val] of Object.entries(opened.v as Record<string, unknown>)) if (typeof val === "string") out[k] = val;
    return out;
  } catch (err) {
    console.error("[compliance] sensitive answers could not be read:", err instanceof Error ? err.message.slice(0, 120) : "unreadable");
    throw new ComplianceError("encryption_unavailable", "These details could not be read. Ask an administrator to check the encryption key.", 500);
  }
}

/** What the browser gets without a reveal: for each sensitive field of the type, whether there is an answer and its mask (never the value). */
export function maskedFields(fields: readonly FieldDef[], values: SensitiveValues): SensitiveField[] {
  return fields
    .filter((f) => f.sensitive)
    .map((f) => {
      const v = values[f.key];
      return { key: f.key, label: f.label, type: f.type, present: typeof v === "string" && v !== "", masked: typeof v === "string" && v !== "" ? maskText(v) : "" };
    });
}

/** The answers of a reveal: label and full text of each field that has one. */
export function revealedFields(fields: readonly FieldDef[], values: SensitiveValues): { key: string; label: FieldDef["label"]; value: string }[] {
  return fields.filter((f) => f.sensitive && typeof values[f.key] === "string" && values[f.key] !== "").map((f) => ({ key: f.key, label: f.label, value: values[f.key] }));
}
