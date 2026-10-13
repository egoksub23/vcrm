// ============================================================
// Compliance requests, the Inbox column (migration 185): the requests linked to THIS conversation or its contact, for the "Compliance requests" section
// next to the ticket history. Server only.
//
//   a person who holds a compliance permission (menu.compliance or review, approve, reveal, execute, manage) sees every request linked to the conversation
//   or to its contact: reference, type, the status in plain words (and the case's own step), when it was raised, and its id to open it
//   anyone else (a person who holds only compliance.raise, or nothing now) sees only the requests THEY raised, as the raiser's minimal projection:
//   reference, type, status, when. No customer, no answer, no bank detail, no reason, no note, and no id.
//
// The conversation is read with the caller's own session (row level security decides whether they may open it). The request rows are read with the service
// role, so this projection is the only way a person without the Compliance menu sees them.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { complianceError } from "../errors";
import { raiserStatus, type LinkedItem } from "../raise-types";
import type { RequestStatus } from "../types";
import { loadTypes } from "./rows";

export interface LinkedCaller {
  accountId: string;
  userId: string;
  /** The person's own session. */
  userDb: SupabaseClient;
  /** They hold a compliance permission (not just compliance.raise). */
  sees: boolean;
}

export type { LinkedItem };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function linkedRequests(admin: SupabaseClient, caller: LinkedCaller, conversationId: string, limit = 50): Promise<LinkedItem[]> {
  if (!UUID_RE.test(conversationId)) throw complianceError("invalid_request");
  const conv = await caller.userDb.from("conversations").select("id, account_id, contact_id").eq("id", conversationId).maybeSingle();
  if (conv.error) throw complianceError("server_error");
  const c = conv.data as { id: string; account_id: string; contact_id: string | null } | null;
  if (!c || c.account_id !== caller.accountId) throw complianceError("not_found");

  let q = admin.from("compliance_requests").select("id, reference, type_key, status, created_at, created_by").eq("account_id", caller.accountId);
  q = c.contact_id ? q.or(`conversation_id.eq.${c.id},contact_id.eq.${c.contact_id}`) : q.eq("conversation_id", c.id);
  if (!caller.sees) q = q.eq("created_by", caller.userId);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(Math.min(Math.max(1, limit), 100));
  if (error) throw complianceError("server_error");
  const rows = (data ?? []) as { id: string; reference: string; type_key: string; status: RequestStatus; created_at: string; created_by: string | null }[];
  if (rows.length === 0) return [];
  const types = new Map((await loadTypes(admin, caller.accountId)).map((x) => [x.key, x]));
  return rows.map((r) => ({
    reference: r.reference,
    typeKey: r.type_key,
    typeLabel: types.get(r.type_key)?.label ?? r.type_key,
    typeLabelL10n: types.get(r.type_key)?.labelL10n ?? {},
    status: raiserStatus(r.status),
    raisedAt: r.created_at,
    ...(caller.sees ? { id: r.id, step: r.status } : {}),
  }));
}
