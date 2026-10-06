// ============================================================
// Registration pages: the values written onto the document when it is made. A template field the sender
// fills (a "merge" field) is named by a key; when the key is one of the usual names for a detail the applicant
// just typed, the page fills it. Only what the applicant typed on this page is used, never what the workspace
// already holds for a contact with a matching address: nothing from a stored record reaches the page of a
// stranger. Keys are compared in lower case. Pure.
// ============================================================

import type { RegistrationDetail } from "./types";

/** The keys that mean each detail. A template can use any of them for the field it wants filled. */
export const MERGE_ALIASES: Record<RegistrationDetail, readonly string[]> = {
  full_name: ["name", "full_name", "fullname", "applicant_name", "contact_name", "contact_person", "person_name"],
  email: ["email", "applicant_email", "contact_email", "email_address"],
  phone: ["phone", "phone_number", "mobile", "mobile_number", "contact_phone", "applicant_phone"],
  company: ["company", "company_name", "business_name", "business", "merchant_name", "merchant", "trading_name"],
};

export interface Applicant {
  fullName: string | null;
  email: string;
  /** Digits only. */
  phone: string | null;
  company: string | null;
}

/** The merge values for the keys a template uses: only keys it uses, only details the applicant gave. */
export function mergeValuesFor(fields: readonly { merge?: string }[], who: Applicant): Record<string, string> {
  const value: Record<RegistrationDetail, string | null> = {
    full_name: who.fullName,
    email: who.email,
    phone: who.phone ? `+${who.phone}` : null,
    company: who.company,
  };
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!f.merge || out[f.merge] !== undefined) continue;
    const key = f.merge.toLowerCase();
    for (const detail of Object.keys(MERGE_ALIASES) as RegistrationDetail[]) {
      if (MERGE_ALIASES[detail].includes(key) && value[detail]) {
        out[f.merge] = value[detail] as string;
        break;
      }
    }
  }
  return out;
}
