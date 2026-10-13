// ============================================================
// Compliance requests: raising a request from an Inbox conversation or a ticket (Part B). Server only.
//
// An agent talking to a customer presses "Raise compliance request". The person needs `compliance.raise`; they do NOT need menu.compliance. What that
// means for what they can see:
//
//   they send     the type, the customer's details (prefilled from the contact), the type's staff fields, when the customer asked (default now; an earlier
//                 time needs a reason), how it arrived and a note
//   they get back the reference, the status, and, only if they hold a compliance permission, the case's id (to link to it). Never an answer, never a bank
//                 detail, never the customer's reason: the case is read by people with menu.compliance and nobody else
//   they can see "my raised requests": reference, type and status of the cases THEY raised (the dedicated projection below). Part A let a raiser read
//                 their case row through the browser's database access; migration 184 removed that, so this is the only way
//
// The conversation or the ticket must be one the person can open: it is read with THEIR session (row level security decides), not the service role.
// Raising refuses when the customer already has an OPEN request of the same type (the same contact, address or phone number); it names the reference
// only to a person who holds a compliance permission, so it cannot be used to find out whether someone has a case.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { postInternalComment } from "@/lib/conversations/comment-write";

import { planDelivery } from "../chat-link/channels";
import { realChatLinkDeps, sendClosureForm, type ChatLinkDeps } from "../chat-link/service";
import { ComplianceError, complianceError } from "../errors";
import { raisedNoteText } from "../raised-note";
import { normalisePhone } from "../reference";
import { raiseFieldsOf, raiserStatus, type RaiseContext, type RaiseResult, type RaisedItem } from "../raise-types";
import type { RequestStatus } from "../types";
import { logEvent } from "./events";
import { realNoticeDeps, sendCustomerNotice, type NoticeDeps, type NoticeResult } from "./notices";
import { loadType } from "./read";
import { loadTypes } from "./rows";
import { createComplianceRequest } from "./write";

export interface RaiseCaller {
  accountId: string;
  userId: string;
  /** The person's own session: what they may open is decided by row level security. */
  userDb: SupabaseClient;
  /** They hold a compliance permission (menu.compliance or a compliance.* work capability): they may be told a reference that exists, and given the case's id. */
  sees: boolean;
}

export type RaiseTarget = { conversationId: string } | { ticketId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ["received", "identity_check", "officer_review", "awaiting_signoff", "approved", "executing"];
/** A request date earlier than this much before now needs a reason. */
export const BACKDATE_GRACE_MS = 2 * 60_000;

interface Resolved {
  kind: "conversation" | "ticket";
  id: string;
  contactId: string | null;
  channel: string | null;
}

async function resolveTarget(caller: RaiseCaller, target: RaiseTarget): Promise<Resolved> {
  const conversationId = "conversationId" in target ? target.conversationId : null;
  const ticketId = "ticketId" in target ? target.ticketId : null;
  if ((conversationId === null) === (ticketId === null)) throw complianceError("invalid_request");
  const id = (conversationId ?? ticketId) as string;
  if (!UUID_RE.test(id)) throw complianceError("invalid_request");
  if (conversationId) {
    const { data, error } = await caller.userDb.from("conversations").select("id, account_id, contact_id, last_channel_type").eq("id", id).maybeSingle();
    if (error) throw complianceError("server_error");
    const c = data as { id: string; account_id: string; contact_id: string | null; last_channel_type: string | null } | null;
    // not there, or not one this person may open: the same answer
    if (!c || c.account_id !== caller.accountId) throw complianceError("not_found");
    return { kind: "conversation", id: c.id, contactId: c.contact_id, channel: c.last_channel_type };
  }
  const { data, error } = await caller.userDb.from("tickets").select("id, account_id, contact_id").eq("id", id).maybeSingle();
  if (error) throw complianceError("server_error");
  const t = data as { id: string; account_id: string; contact_id: string | null } | null;
  if (!t || t.account_id !== caller.accountId) throw complianceError("not_found");
  return { kind: "ticket", id: t.id, contactId: t.contact_id, channel: null };
}

async function loadContact(admin: SupabaseClient, accountId: string, contactId: string | null) {
  if (!contactId) return null;
  const { data } = await admin.from("contacts").select("id, name, phone, email, language").eq("id", contactId).eq("account_id", accountId).maybeSingle();
  return (data as { id: string; name: string | null; phone: string | null; email: string | null; language: string | null } | null) ?? null;
}

/** The open request of this type for this customer (the same contact, email address or phone number), or null. */
async function findOpen(admin: SupabaseClient, accountId: string, typeKey: string, who: { contactId: string | null; email: string | null; phone: string | null }): Promise<{ reference: string } | null> {
  const open = await admin.from("compliance_requests").select("reference, contact_id, customer_email, customer_phone, status").eq("account_id", accountId).eq("type_key", typeKey).in("status", OPEN_STATUSES).limit(500);
  if (open.error) throw complianceError("server_error");
  const email = who.email?.trim().toLowerCase() || null;
  for (const r of (open.data ?? []) as { reference: string; contact_id: string | null; customer_email: string | null; customer_phone: string | null }[]) {
    if (who.contactId && r.contact_id === who.contactId) return r;
    if (email && (r.customer_email ?? "").trim().toLowerCase() === email) return r;
    if (who.phone && r.customer_phone === who.phone) return r;
  }
  return null;
}

/** What the dialog needs: the contact (to prefill), the channel, the types with the fields a person fills, and which types already have an open request. */
export async function raiseContext(admin: SupabaseClient, caller: RaiseCaller, target: RaiseTarget, chat: ChatLinkDeps = realChatLinkDeps): Promise<RaiseContext> {
  const t = await resolveTarget(caller, target);
  const contact = await loadContact(admin, caller.accountId, t.contactId);
  // can the closure form go into this chat as a card? (a ticket has no chat)
  let chatLink: RaiseContext["chatLink"];
  if (t.kind !== "conversation") chatLink = { available: false, reason: "no_channel" };
  else {
    const plan = planDelivery(t.channel, { whatsappWindowOpen: t.channel === "whatsapp" ? await chat.windowOpen(admin, t.id) : false });
    chatLink = plan.send ? { available: true } : { available: false, reason: plan.reason };
  }
  const types = (await loadTypes(admin, caller.accountId)).filter((x) => x.active);
  const phone = contact?.phone ? normalisePhone(contact.phone) : null;
  const open: string[] = [];
  for (const type of types) if (await findOpen(admin, caller.accountId, type.key, { contactId: t.contactId, email: contact?.email ?? null, phone })) open.push(type.key);
  return {
    contact,
    channel: t.channel,
    chatLink,
    types: types.map((x) => ({ key: x.key, label: x.label, labelL10n: x.labelL10n, fields: raiseFieldsOf(x.fields) })),
    open,
  };
}

export { PUBLIC_ONLY_FIELDS, raiseFieldsOf, raiserStatus } from "../raise-types";
export type { RaiseContext, RaiseResult, RaisedItem, RaiserStatus } from "../raise-types";

export interface RaiseInput {
  typeKey: string;
  target: RaiseTarget;
  customerName: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  /** The type's staff fields. */
  answers: Record<string, unknown>;
  /** How the request arrived (free text up to 60 characters; the conversation's channel when omitted). */
  channel?: string | null;
  /** When the customer asked. Omit for now. Earlier than a couple of minutes ago needs `receivedAtReason`. */
  receivedAt?: string | null;
  receivedAtReason?: string | null;
  /** A note for the people who will handle it (shown on the case's timeline). */
  note?: string | null;
  /** Email the customer the confirmation (needs an address). */
  notify?: boolean;
  /**
   * Account closure raised from a conversation: send the customer the personal closure form in that chat (migration 185). The case is made FIRST; the
   * acknowledgements and bank details are then the customer's to fill in, so they are not asked of the agent. A problem with the chat never undoes the case.
   */
  sendClosureForm?: boolean;
}

const NOTE_MAX = 1000;

export async function raiseRequest(admin: SupabaseClient, caller: RaiseCaller, input: RaiseInput, deps: NoticeDeps = realNoticeDeps, chat: ChatLinkDeps = realChatLinkDeps): Promise<RaiseResult> {
  const type = await loadType(admin, caller.accountId, input.typeKey);
  if (!type || !type.active) throw complianceError("type_unavailable");
  const t = await resolveTarget(caller, input.target);
  const email = (input.customerEmail ?? "").trim() || null;
  const rawPhone = (input.customerPhone ?? "").trim();
  const phone = rawPhone ? normalisePhone(rawPhone) : null;
  const dup = await findOpen(admin, caller.accountId, type.key, { contactId: t.contactId, email, phone });
  if (dup) {
    throw new ComplianceError("duplicate_open", "This customer already has an open request of this type.", 409, caller.sees ? [{ field: "reference", code: dup.reference }] : undefined);
  }

  // when the customer asked: now, or earlier with a reason (the case's clock starts there, so it is the one date that is audited)
  let receivedAt: string | null = null;
  if (input.receivedAt) {
    const ms = Date.parse(input.receivedAt);
    if (!Number.isFinite(ms)) throw new ComplianceError("validation_failed", "That request date is not valid.", 400, [{ field: "received_at", code: "invalid" }]);
    if (ms < deps.now().getTime() - BACKDATE_GRACE_MS) {
      if ((input.receivedAtReason ?? "").trim() === "") throw new ComplianceError("note_required", "Say why the request date is earlier.", 400, [{ field: "received_at_reason", code: "required" }]);
      receivedAt = new Date(ms).toISOString();
    }
  }
  const note = (input.note ?? "").trim();
  if (note.length > NOTE_MAX) throw new ComplianceError("validation_failed", "That note is too long.", 400, [{ field: "note", code: "too_long" }]);
  const reason = (input.receivedAtReason ?? "").trim();
  if (reason.length > NOTE_MAX) throw new ComplianceError("validation_failed", "That reason is too long.", 400, [{ field: "received_at_reason", code: "too_long" }]);

  // the closure form goes to the customer in this chat: the customer fills in the acknowledgements and the bank details, so the agent's answers may be partial
  const sendForm = input.sendClosureForm === true && type.key === "closure" && t.kind === "conversation";

  const created = await createComplianceRequest(admin, {
    accountId: caller.accountId,
    typeKey: type.key,
    answersPartial: sendForm,
    source: t.kind === "conversation" ? "inbox" : "ticket",
    channel: (input.channel ?? "").trim() || t.channel || (t.kind === "ticket" ? "ticket" : null),
    customerName: input.customerName,
    customerEmail: email,
    customerPhone: phone ?? (rawPhone || null),
    answers: input.answers,
    receivedAt,
    createdBy: caller.userId,
    contactId: t.contactId,
    conversationId: t.kind === "conversation" ? t.id : null,
    ticketId: t.kind === "ticket" ? t.id : null,
    customerLocale: null,
  });

  // what the person wrote about it goes on the case's timeline, as a note by them
  if (receivedAt && reason) await logEvent(admin, { accountId: caller.accountId, requestId: created.id, actor: caller.userId, kind: "note", detail: { text: `Request date set earlier by the person who raised it. Reason: ${reason}` } });
  if (note) await logEvent(admin, { accountId: caller.accountId, requestId: created.id, actor: caller.userId, kind: "note", detail: { text: note } });

  // the conversation or the ticket says it was raised (the reference only: everyone who can open it sees this line)
  await writeRaisedNote(admin, caller, t, created.reference);

  let notice: NoticeResult | undefined;
  if (input.notify === true && email) notice = await sendCustomerNotice(admin, deps, { accountId: caller.accountId, requestId: created.id, kind: "received", actor: caller.userId }).catch(() => undefined);

  // THEN the link: the case exists already, so nothing about the chat can undo it
  let chatLink: RaiseResult["chatLink"];
  if (sendForm) {
    chatLink = await sendClosureForm(admin, chat, { accountId: caller.accountId, requestId: created.id, actor: caller.userId, conversationId: t.id, resend: false }).catch((err) => {
      console.error("[compliance] the closure form link could not be made:", err instanceof ComplianceError ? err.code : "error");
      return undefined;
    });
  }

  return { reference: created.reference, status: "received", ...(caller.sees ? { id: created.id } : {}), ...(notice ? { notice } : {}), ...(chatLink ? { chatLink } : {}) };
}

/** The line left on the conversation (an internal note) or the ticket (a comment): "Compliance request CMP-2026-000014 raised". Never fails the raise. */
async function writeRaisedNote(admin: SupabaseClient, caller: RaiseCaller, t: Resolved, reference: string): Promise<void> {
  const text = raisedNoteText(reference);
  try {
    if (t.kind === "conversation") {
      await postInternalComment(admin, { accountId: caller.accountId, conversationId: t.id, userId: caller.userId, text });
    } else {
      const { error } = await admin.from("ticket_comments").insert({ ticket_id: t.id, account_id: caller.accountId, author_id: caller.userId, body: text });
      if (error) throw new Error("ticket note failed");
    }
  } catch {
    console.error("[compliance] the note about a raised request could not be written");
  }
}

// ---- what a raiser sees ---------------------------------------------------------------------------------------------------

export async function raisedByMe(admin: SupabaseClient, caller: RaiseCaller, scope: { conversationId?: string | null; ticketId?: string | null; limit?: number } = {}): Promise<RaisedItem[]> {
  if (scope.conversationId && !UUID_RE.test(scope.conversationId)) throw complianceError("invalid_request");
  if (scope.ticketId && !UUID_RE.test(scope.ticketId)) throw complianceError("invalid_request");
  let q = admin.from("compliance_requests").select("id, reference, type_key, status, created_at").eq("account_id", caller.accountId).eq("created_by", caller.userId);
  if (scope.conversationId) q = q.eq("conversation_id", scope.conversationId);
  if (scope.ticketId) q = q.eq("ticket_id", scope.ticketId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(Math.min(Math.max(1, scope.limit ?? 20), 50));
  if (error) throw complianceError("server_error");
  const types = new Map((await loadTypes(admin, caller.accountId)).map((x) => [x.key, x]));
  return ((data ?? []) as { id: string; reference: string; type_key: string; status: RequestStatus; created_at: string }[]).map((r) => ({
    reference: r.reference,
    typeKey: r.type_key,
    typeLabel: types.get(r.type_key)?.label ?? r.type_key,
    typeLabelL10n: types.get(r.type_key)?.labelL10n ?? {},
    status: raiserStatus(r.status),
    raisedAt: r.created_at,
    ...(caller.sees ? { id: r.id } : {}),
  }));
}
