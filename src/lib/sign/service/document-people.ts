// ============================================================
// Doc Sign, the people of a document on its own, saved the way a collection's are (the one workflow of the sending screens).
//
// The sender adds the people BEFORE any signature block is placed, so a person must be able to exist before a role does. As for a collection:
//   - an uploaded file has no roles of its own: each person who must sign becomes a role of it (the person's key is the role's key, their name
//     the role's label), so a block assigned in the editor to that role is assigned to that person, and a rename keeps the fields. A person taken
//     off the list takes the fields assigned to them off the document (nobody could complete them); the screen asks first.
//   - a document from a template keeps the template's roles and `roles` says which person has which.
// The rows of the signing list and the roles are written together, so a row always names a role the document has. The same pure functions as
// the collection's (`planSigners`, `syncDocumentRoles`, `rowsFor`) decide what is made; only the writing is different (one document, no party).
// ============================================================

import { randomUUID } from "node:crypto";

import { rowsFor, syncDocumentRoles } from "../envelopes";
import type { SignSignerRow } from "../types";
import { loadDocument, type SignCtx } from "./context";
import { assertMayEditDraft } from "./privacy";
import { setSigners, updateDraft, type SignerInput } from "./drafts";
import { SignError } from "./errors";
import { lite, planSigners, type EnvelopePersonInput } from "./envelopes";

/**
 * Replace the signing list of a draft document with these people (the people who receive a copy are saved apart, see copy-recipients.ts). `ordered`
 * is whether the document needs signing order as the screen has it (the document's own setting may not have been saved yet).
 */
export async function setDocumentPeople(ctx: SignCtx, documentId: string, people: readonly EnvelopePersonInput[], opts: { ordered?: boolean } = {}): Promise<SignSignerRow[]> {
  const doc = await loadDocument(ctx, documentId);
  if (doc.status !== "draft") throw new SignError("document_not_draft", "This document was already sent.", 409);
  await assertMayEditDraft(ctx, doc);
  if (doc.envelope_id) throw new SignError("document_in_envelope", "This document is part of a document collection. Change the people on the collection.", 409);
  const ordered = opts.ordered ?? doc.sign_in_order;
  const fromTemplate = !!doc.template_version_id;

  // an uploaded file may already have roles of its own from before people made roles: a person who holds one keeps it (their fields stay)
  const own = fromTemplate ? undefined : new Set((doc.roles_snapshot ?? []).map((r) => r.key));
  const { list, derivedFinished } = planSigners([doc], people, { ordered, extraKeys: own });

  if (!fromTemplate) {
    const sync = syncDocumentRoles({ roles: doc.roles_snapshot ?? [], fields: doc.fields_snapshot ?? [] }, list);
    if (sync.changed) await updateDraft(ctx, documentId, { roles: sync.roles, ...(sync.removed > 0 ? { fields: sync.fields } : {}) }, { viaEnvelope: true });
  }

  const fresh = await loadDocument(ctx, documentId);
  const rows = rowsFor([lite(fresh)], derivedFinished, { ordered, newId: randomUUID });
  const inputs: SignerInput[] = rows.map((r) => ({ roleKey: r.roleKey, kind: r.kind, fullName: r.fullName, email: r.email, phone: r.phone, channel: r.channel, orderNo: r.orderNo, ...(r.internalUserId ? { internalUserId: r.internalUserId } : {}) }));
  return setSigners(ctx, documentId, inputs);
}
