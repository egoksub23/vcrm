// ============================================================
// Doc Sign, the sending workflow: the documents and the people the tests share (a document as the steps read it, a person, the options).
// Only the tests import this.
// ============================================================

import type { EnvelopePerson } from "../envelopes";
import type { SignRole } from "../types";
import type { DraftOptions } from "./draft-options";
import type { ProcessDoc } from "./process";

export const role = (key: string, label: string, color = 0, kind: SignRole["kind"] = "signer"): SignRole => ({ key, label, kind, color });

/** A document as the steps read it. `n` makes its id and title. */
export function processDoc(n: number, over: Partial<ProcessDoc> = {}): ProcessDoc {
  return {
    id: `0000000${n}-0000-4000-8000-000000000000`,
    position: n,
    title: `Document ${n}`,
    reference: `SGN-2026-00000${n}`,
    status: "draft",
    mode: "sign",
    pageCount: n,
    roles: [],
    rolesNeeded: [],
    fromTemplate: false,
    fieldCounts: {},
    signatureCounts: {},
    partCounts: {},
    hasFile: true,
    hasForm: false,
    categoryId: null,
    completedAt: null,
    hasFinalFile: false,
    ...over,
  };
}

export function person(key: string, name: string, over: Partial<EnvelopePerson> = {}): EnvelopePerson {
  return { key, fullName: name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`, phone: "", channel: "email", step: 1, roles: {}, ...over };
}

export const baseOptions: DraftOptions = {
  title: "Merchant Agreement",
  categoryId: null,
  contactId: null,
  ticketId: null,
  dealId: null,
  locale: "en",
  message: "",
  expiryDate: "",
  reminderText: "3, 7",
  codeRequired: false,
  signInOrder: false,
  allowForwarding: false,
};
