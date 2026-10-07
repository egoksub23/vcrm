// ============================================================
// Doc Sign: a document as a screen of the sending workflow needs to read it (the one workflow of a single document and a document collection):
// its title, its pages, its roles, and what is placed for each role. No fields, no form, no values: just the counts. A pure function over the
// row, so the server (the collection's data) and the browser (a single document's own screen) say the same thing.
// ============================================================

import type { SignDocumentRow, SignRole } from "../types";
import { isFormMode } from "../types";
import { fieldsForRole } from "../rules";
import { roleHasWork } from "./roles";

/** A document of a process as a screen needs it: no fields, no form, no values. */
export interface EnvelopeDocumentSummary {
  id: string;
  position: number;
  title: string;
  reference: string | null;
  status: SignDocumentRow["status"];
  mode: "sign" | "form";
  pageCount: number | null;
  roles: SignRole[];
  /** The roles that have something to complete on this document (the others need nobody). */
  rolesNeeded: string[];
  /** Made from a template (its roles are the template's, matched to people), as against an uploaded file (its roles are the people's). */
  fromTemplate: boolean;
  /** How many fields a person completes are assigned to each role, by role key (so the screen can say what removing a person takes with them). */
  fieldCounts: Record<string, number>;
  /** How many signature blocks (a signature or initials) are assigned to each role, by role key. */
  signatureCounts: Record<string, number>;
  /** How many parts of the form each role completes, by role key (a document with no form has none). */
  partCounts: Record<string, number>;
  /** The document has a file to put blocks on. */
  hasFile: boolean;
  /** The document carries a form (a template with parts). */
  hasForm: boolean;
  categoryId: string | null;
  completedAt: string | null;
  hasFinalFile: boolean;
  /** Migration 178: the document's certificate is a file of its own (offered beside the signed file). False for a document sealed earlier: it is inside the signed file. */
  hasCertificate?: boolean;
}

/** The signature blocks of a role: a signature or initials placed for it. */
const signatureBlocks = (d: SignDocumentRow, roleKey: string): number => (d.fields_snapshot ?? []).filter((f) => f.role === roleKey && (f.type === "signature" || f.type === "initials")).length;

export function summarizeDocument(d: SignDocumentRow): EnvelopeDocumentSummary {
  const roles = d.roles_snapshot ?? [];
  const parts = d.form_snapshot?.parts ?? [];
  return {
    id: d.id,
    position: d.envelope_position ?? 0,
    title: d.title,
    reference: d.reference,
    status: d.status,
    mode: isFormMode(d) ? "form" : "sign",
    pageCount: d.page_count,
    roles,
    rolesNeeded: roles.filter((r) => roleHasWork(d, r.key)).map((r) => r.key),
    fromTemplate: !!d.template_version_id,
    fieldCounts: Object.fromEntries(roles.map((r) => [r.key, fieldsForRole(d.fields_snapshot ?? [], r.key).length])),
    signatureCounts: Object.fromEntries(roles.map((r) => [r.key, signatureBlocks(d, r.key)])),
    partCounts: Object.fromEntries(roles.map((r) => [r.key, parts.filter((p) => p.role === r.key).length])),
    hasFile: !!d.base_path,
    hasForm: parts.length > 0,
    categoryId: d.category_id,
    completedAt: d.completed_at,
    hasFinalFile: !!d.final_path,
    hasCertificate: !!d.final_path && !!d.certificate_path,
  };
}
