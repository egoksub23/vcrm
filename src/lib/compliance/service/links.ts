// ============================================================
// Compliance requests: finding what to link a case to (a contact, a ticket, an incident). Server only. The browser never types an id: it searches here,
// gets at most five choices from the caller's own workspace, and sends the chosen id back through the edit route (the database then checks, once more,
// that the id belongs to the same workspace).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { complianceError } from "../errors";
import type { ComplianceCaller } from "./rows";
import { searchTerm } from "./read";

export interface LinkChoice {
  kind: "contact" | "ticket" | "incident";
  id: string;
  label: string;
}

export const LINK_KINDS = ["contact", "ticket", "incident"] as const;
const MAX = 5;

export async function lookupLinks(admin: SupabaseClient, caller: ComplianceCaller, kind: LinkChoice["kind"], q: string): Promise<LinkChoice[]> {
  if (!(caller.viewer.canReview || caller.viewer.canApprove)) throw complianceError("forbidden");
  const term = searchTerm(q);
  if (term.length < 2 && !/^\d+$/.test(term)) return [];
  if (kind === "ticket") {
    let query = admin.from("tickets").select("id, ticket_number, subject").eq("account_id", caller.accountId);
    query = /^\d{1,9}$/.test(term) ? query.eq("ticket_number", Number(term)) : query.ilike("subject", `%${term}%`);
    const { data } = await query.order("ticket_number", { ascending: false }).limit(MAX);
    return ((data ?? []) as { id: string; ticket_number: number; subject: string }[]).map((r) => ({ kind, id: r.id, label: `#${r.ticket_number} ${r.subject ?? ""}`.trim().slice(0, 120) }));
  }
  if (kind === "incident") {
    let query = admin.from("incidents").select("id, incident_number, title").eq("account_id", caller.accountId);
    query = /^\d{1,9}$/.test(term) ? query.eq("incident_number", Number(term)) : query.ilike("title", `%${term}%`);
    const { data } = await query.order("incident_number", { ascending: false }).limit(MAX);
    return ((data ?? []) as { id: string; incident_number: number; title: string }[]).map((r) => ({ kind, id: r.id, label: `#${r.incident_number} ${r.title ?? ""}`.trim().slice(0, 120) }));
  }
  const { data } = await admin
    .from("contacts")
    .select("id, name, phone, email")
    .eq("account_id", caller.accountId)
    .is("deleted_at", null)
    .or(`name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(MAX);
  return ((data ?? []) as { id: string; name: string | null; phone: string | null; email: string | null }[]).map((r) => ({
    kind,
    id: r.id,
    label: [r.name, r.phone, r.email].filter(Boolean).join(" · ").slice(0, 120) || r.id,
  }));
}
