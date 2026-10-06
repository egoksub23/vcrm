// ============================================================
// Attaching a document to a ticket or a deal (F-51). The columns `sign_documents.ticket_id` and `deal_id` exist since 157; this
// is the one place that decides whether a pair of ids is allowed, shared by every way a document is made or changed (the
// new-document page, the template picker, the public API, a bulk batch, the draft's own editor):
//
//   * the ticket and the deal must belong to THIS workspace (a service-role read, so this is the check; migration 170 holds the
//     same line in the database for anything that forgets);
//   * when the document has a contact, the ticket's and the deal's contact must be that same person: a document for Ali is not
//     filed on the ticket of Bala;
//   * when the document has no contact yet, it takes the ticket's (or the deal's): a document attached to a record always has
//     that record's contact, so it shows on that contact's Documents tab too;
//   * a ticket and a deal named together must be about the same contact.
//
// Pure decision (`decideLinks`) apart from the two reads, so the rules are tested without a database.
// ============================================================

import type { SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

export interface LinkTarget {
  id: string;
  contactId: string | null;
}

export interface LinkInput {
  contactId: string | null;
  ticket: LinkTarget | null;
  deal: LinkTarget | null;
}

export interface LinkResult {
  contactId: string | null;
  ticketId: string | null;
  dealId: string | null;
}

/** Which of the records disagrees with the contact: a stable code the screens word. */
export function decideLinks(input: LinkInput): LinkResult {
  let contactId = input.contactId;
  for (const [kind, target] of [["ticket", input.ticket], ["deal", input.deal]] as const) {
    if (!target) continue;
    if (target.contactId && contactId && target.contactId !== contactId) {
      throw new SignError(`${kind}_contact_mismatch`, kind === "ticket" ? "That ticket belongs to a different contact than this document." : "That deal belongs to a different contact than this document.", 400);
    }
    if (!contactId && target.contactId) contactId = target.contactId;
  }
  return { contactId, ticketId: input.ticket?.id ?? null, dealId: input.deal?.id ?? null };
}

async function loadTarget(ctx: SignCtx, table: "tickets" | "deals", id: string, missing: { code: string; message: string }): Promise<LinkTarget> {
  const { data, error } = await ctx.admin.from(table).select("id, contact_id").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
  if (error) raiseDatabaseError(error, `load ${table === "tickets" ? "ticket" : "deal"}`);
  if (!data) throw new SignError(missing.code, missing.message, 400);
  const row = data as { id: string; contact_id: string | null };
  return { id: row.id, contactId: row.contact_id ?? null };
}

/**
 * The contact, ticket and deal a document may carry, from what the caller asked for. `contactId` is a contact that has already
 * been checked to be in the workspace (or null). A null ticket or deal means "not attached".
 */
export async function resolveLinks(ctx: SignCtx, args: { contactId: string | null; ticketId?: string | null; dealId?: string | null }): Promise<LinkResult> {
  const ticket = args.ticketId ? await loadTarget(ctx, "tickets", args.ticketId, { code: "ticket_not_found", message: "That ticket was not found." }) : null;
  const deal = args.dealId ? await loadTarget(ctx, "deals", args.dealId, { code: "deal_not_found", message: "That deal was not found." }) : null;
  return decideLinks({ contactId: args.contactId, ticket, deal });
}
