// ============================================================
// Compliance requests: creating and editing a case. Server only.
//
// `createComplianceRequest` is THE function that makes a case. Staff use it from the New request screen (source "staff"); Part B calls it from the
// public parent form (source "form", no createdBy), from "Raise from Inbox" (source "inbox") and "Raise from a ticket" (source "ticket"), passing the
// links and the channel. It validates the answers against the type, encrypts the sensitive ones, and lets the database do the rest (the reference,
// the clocks, the checklist, the created event, the retention date, the check that every link is in this workspace).
// ============================================================

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { complianceError, fromDatabase, ComplianceError } from "../errors";
import { checkAnswers } from "../fields";
import { normalisePhone } from "../reference";
import { openSensitive, sealSensitive } from "../secrets";
import { isDataEditable } from "../transitions";
import { SOURCES, LOCALES, type CustomerLocale, type RequestSource } from "../types";
import { logEvent } from "./events";
import { loadRow, loadType } from "./read";
import type { ComplianceCaller } from "./rows";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateRequestInput {
  /** A case id chosen by the caller (the public form uploads the files under the case's folder before the case exists). Omit for a new one. */
  id?: string;
  accountId: string;
  typeKey: string;
  /** Where the request came from: the public form, a member of staff, the Inbox, a ticket. */
  source: RequestSource;
  /** The channel the customer used (whatsapp, email, form, phone ...). Free text up to 60 characters. */
  channel?: string | null;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  /** The answers of the type's form, by field key (sensitive ones included; they are encrypted here). */
  answers: Record<string, unknown>;
  /** The request date. Omit for now. Staff may set it for a case raised in a chat; the created event records that it was set (backdated). */
  receivedAt?: string | null;
  /** The login that made the case; null for the public form. */
  createdBy?: string | null;
  assignedTo?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  ticketId?: string | null;
  incidentId?: string | null;
  kycValidationRef?: string | null;
  isTest?: boolean;
  /** The language the customer's emails go out in (the form's language choice, or the contact's). Omit: the contact's, else English. */
  customerLocale?: CustomerLocale | null;
  /** When the customer proved the email address with the emailed code (the public form). */
  emailVerifiedAt?: string | null;
}

const idOrNull = (v: string | null | undefined, what: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (!UUID_RE.test(v)) throw new ComplianceError("validation_failed", `${what} is not valid.`, 400, [{ field: what, code: "invalid" }]);
  return v;
};

function cleanCustomer(input: { customerName: string; customerEmail?: string | null; customerPhone?: string | null }) {
  const name = (input.customerName ?? "").trim();
  if (name === "" || name.length > 200) throw new ComplianceError("validation_failed", "Enter the customer's name.", 400, [{ field: "customer_name", code: name === "" ? "required" : "too_long" }]);
  const email = (input.customerEmail ?? "").trim();
  if (email !== "" && (!EMAIL_RE.test(email) || email.length > 320)) throw new ComplianceError("validation_failed", "That email address is not valid.", 400, [{ field: "customer_email", code: "invalid" }]);
  const rawPhone = (input.customerPhone ?? "").trim();
  const phone = rawPhone === "" ? null : normalisePhone(rawPhone);
  if (rawPhone !== "" && !phone) throw new ComplianceError("validation_failed", "That phone number is not valid.", 400, [{ field: "customer_phone", code: "invalid" }]);
  return { name, email: email === "" ? null : email, phone };
}

export async function createComplianceRequest(admin: SupabaseClient, input: CreateRequestInput): Promise<{ id: string; reference: string }> {
  if (!(SOURCES as readonly string[]).includes(input.source)) throw complianceError("invalid_request");
  const type = await loadType(admin, input.accountId, input.typeKey);
  if (!type || !type.active) throw complianceError("type_unavailable");
  const customer = cleanCustomer(input);
  const checked = checkAnswers(type.fields, input.answers ?? {});
  if (!checked.ok) throw new ComplianceError("validation_failed", "Some answers need attention.", 400, checked.issues);

  let receivedAt: string | undefined;
  if (input.receivedAt) {
    const t = Date.parse(input.receivedAt);
    if (!Number.isFinite(t)) throw new ComplianceError("validation_failed", "That request date is not valid.", 400, [{ field: "received_at", code: "invalid" }]);
    receivedAt = new Date(t).toISOString();
  }
  const id = input.id ? (idOrNull(input.id, "id") as string) : randomUUID();
  const dataEnc = sealSensitive(id, checked.answers.sensitive);
  const locale = input.customerLocale && (LOCALES as readonly string[]).includes(input.customerLocale) ? input.customerLocale : null;
  const { data, error } = await admin
    .from("compliance_requests")
    .insert({
      id,
      account_id: input.accountId,
      type_key: type.key,
      source: input.source,
      channel: (input.channel ?? "").trim().slice(0, 60) || null,
      customer_name: customer.name,
      customer_email: customer.email,
      customer_phone: customer.phone,
      contact_id: idOrNull(input.contactId, "contact_id"),
      conversation_id: idOrNull(input.conversationId, "conversation_id"),
      ticket_id: idOrNull(input.ticketId, "ticket_id"),
      incident_id: idOrNull(input.incidentId, "incident_id"),
      kyc_validation_ref: (input.kycValidationRef ?? "").trim().slice(0, 200) || null,
      data: checked.answers.data,
      data_enc: dataEnc,
      created_by: input.createdBy ?? null,
      assigned_to: idOrNull(input.assignedTo, "assigned_to"),
      is_test: input.isTest === true,
      customer_locale: locale,
      email_verified_at: input.emailVerifiedAt ?? null,
      ...(receivedAt ? { received_at: receivedAt } : {}),
    })
    .select("id, reference")
    .single();
  if (error || !data) throw fromDatabase(error);
  return { id: (data as { id: string }).id, reference: (data as { reference: string }).reference };
}

// ---- editing ------------------------------------------------------------------------------------------------------------

export interface EditRequestInput {
  customerName?: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  channel?: string | null;
  receivedAt?: string;
  /** Some of the type's non-sensitive answers (merged into the existing ones). */
  answers?: Record<string, unknown>;
  /** Some of the type's sensitive answers (merged into the existing ones; needs compliance.reveal). */
  sensitive?: Record<string, unknown>;
  contactId?: string | null;
  conversationId?: string | null;
  ticketId?: string | null;
  incidentId?: string | null;
  kycValidationRef?: string | null;
  assignedTo?: string | null;
}

export async function editRequest(admin: SupabaseClient, caller: ComplianceCaller, id: string, input: EditRequestInput): Promise<{ changed: string[] }> {
  if (!(caller.viewer.canReview || caller.viewer.canApprove)) throw complianceError("forbidden");
  const row = await loadRow(admin, caller.accountId, id);
  const type = await loadType(admin, caller.accountId, row.type_key);
  const patch: Record<string, unknown> = {};

  const touchesAnswers = input.answers !== undefined || input.sensitive !== undefined;
  const touchesCustomer = input.customerName !== undefined || input.customerEmail !== undefined || input.customerPhone !== undefined || input.channel !== undefined || input.receivedAt !== undefined;
  if ((touchesAnswers || touchesCustomer) && !isDataEditable(row.status)) throw complianceError("frozen");

  if (input.customerName !== undefined || input.customerEmail !== undefined || input.customerPhone !== undefined) {
    const c = cleanCustomer({
      customerName: input.customerName ?? row.customer_name,
      customerEmail: input.customerEmail === undefined ? row.customer_email : input.customerEmail,
      customerPhone: input.customerPhone === undefined ? row.customer_phone : input.customerPhone,
    });
    if (input.customerName !== undefined) patch.customer_name = c.name;
    if (input.customerEmail !== undefined) patch.customer_email = c.email;
    if (input.customerPhone !== undefined) patch.customer_phone = c.phone;
  }
  if (input.channel !== undefined) patch.channel = (input.channel ?? "").trim().slice(0, 60) || null;
  if (input.receivedAt !== undefined) {
    const t = Date.parse(input.receivedAt);
    if (!Number.isFinite(t)) throw new ComplianceError("validation_failed", "That request date is not valid.", 400, [{ field: "received_at", code: "invalid" }]);
    patch.received_at = new Date(t).toISOString();
  }

  if (touchesAnswers && type) {
    const checked = checkAnswers(
      type.fields,
      { ...(input.answers ?? {}), ...(input.sensitive ?? {}) },
      { partial: true },
    );
    if (!checked.ok) throw new ComplianceError("validation_failed", "Some answers need attention.", 400, checked.issues);
    if (Object.keys(checked.answers.sensitive).length > 0) {
      // changing a bank detail needs the same permission as reading it
      if (!caller.viewer.canReveal) throw complianceError("forbidden");
      const merged = { ...openSensitive(row.id, row.data_enc), ...checked.answers.sensitive };
      patch.data_enc = sealSensitive(row.id, merged);
    }
    // a sent field the form does not know is ignored; an ordinary answer is merged into the stored ones
    if (Object.keys(checked.answers.data).length > 0) patch.data = { ...(row.data ?? {}), ...checked.answers.data };
  }

  if (input.contactId !== undefined) patch.contact_id = idOrNull(input.contactId, "contact_id");
  if (input.conversationId !== undefined) patch.conversation_id = idOrNull(input.conversationId, "conversation_id");
  if (input.ticketId !== undefined) patch.ticket_id = idOrNull(input.ticketId, "ticket_id");
  if (input.incidentId !== undefined) patch.incident_id = idOrNull(input.incidentId, "incident_id");
  if (input.kycValidationRef !== undefined) patch.kyc_validation_ref = (input.kycValidationRef ?? "").trim().slice(0, 200) || null;
  if (input.assignedTo !== undefined) patch.assigned_to = idOrNull(input.assignedTo, "assigned_to");

  if (Object.keys(patch).length === 0) return { changed: [] };
  const { data, error } = await admin.rpc("compliance_update_request", { p_request: row.id, p_actor: caller.userId, p_patch: patch });
  if (error) throw fromDatabase(error);
  return { changed: ((data as { changed?: string[] } | null)?.changed ?? []) as string[] };
}

// ---- notes ----------------------------------------------------------------------------------------------------------------

export const NOTE_MAX = 2000;

export async function addNote(admin: SupabaseClient, caller: ComplianceCaller, id: string, text: string): Promise<void> {
  if (!(caller.viewer.canReview || caller.viewer.canApprove)) throw complianceError("forbidden");
  const note = (text ?? "").trim();
  if (note === "") throw complianceError("note_required");
  if (note.length > NOTE_MAX) throw new ComplianceError("validation_failed", "That note is too long.", 400, [{ field: "note", code: "too_long" }]);
  const row = await loadRow(admin, caller.accountId, id);
  if (!(await logEvent(admin, { accountId: caller.accountId, requestId: row.id, actor: caller.userId, kind: "note", detail: { text: note } }))) throw complianceError("audit_failed");
}
