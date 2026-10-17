// ============================================================
// The contact changes a document's answers made (the `writeback` events), for the sender's history. The old and new
// value of a contact are personal data, so they are given only to a person who holds `sign.reveal-sensitive` (the
// capability that guards sensitive answers); everyone else with the Secure Sign menu is given the field that changed
// and a mask. The decision is made here, on the server, from the capability the route checked: the browser's history
// query does not select these values at all (components/sign/detail/events.ts `WRITEBACK_COLUMNS`), so they are
// never in a page of a person who may not see them. Route: GET /api/sign/documents/[id]/writebacks.
// ============================================================

import { hideText } from "../forms";
import type { WritebackChange, WritebackHistory } from "../forms/api-types";
import { loadDocument, type SignCtx } from "./context";
import { raiseDatabaseError } from "./errors";

/** The most write-back events one document can show. */
const MAX_EVENTS = 500;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * The write-backs of a document, oldest first. `mayReveal` is whether the caller holds `sign.reveal-sensitive`; without it every value
 * that was not empty is `••••` (`hideText`) and `masked` is true. A private document the caller may not see is "not found" (loadDocument).
 */
export async function loadWritebackHistory(ctx: SignCtx, documentId: string, mayReveal: boolean): Promise<WritebackHistory> {
  await loadDocument(ctx, documentId);
  const { data, error } = await ctx.admin
    .from("sign_events")
    .select("doc_seq, detail")
    .eq("document_id", documentId)
    .eq("account_id", ctx.accountId)
    .eq("type", "writeback")
    .order("doc_seq", { ascending: true })
    .limit(MAX_EVENTS);
  if (error) raiseDatabaseError(error, "load write-backs");

  const changes: WritebackChange[] = [];
  for (const row of (data ?? []) as { doc_seq: number; detail: Record<string, unknown> | null }[]) {
    const detail = row.detail ?? {};
    const field = str(detail.field).trim();
    if (!field) continue;
    const before = str(detail.old);
    const after = str(detail.new);
    changes.push({ seq: row.doc_seq, field, old: mayReveal ? before : hideText(before), new: mayReveal ? after : hideText(after), masked: !mayReveal });
  }
  return { mayReveal, changes };
}
