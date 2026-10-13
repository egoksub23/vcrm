// ============================================================
// Compliance requests, the personal closure form link in a chat (migration 185): who may act on it, and reading it (the case page's list, the Inbox
// cards' status). SERVER ONLY, but with no send pipeline in it, so the case's detail can read it cheaply.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { complianceError } from "../errors";
import { loadPeople, personRef, type RequestRow } from "../service/rows";
import { linkState } from "./link-state";
import type { CardStatus, FormLinkView } from "./types";

/** Who is acting, and what they hold. `canReview` is compliance.review or compliance.approve; `canRaise` is compliance.raise. */
export interface LinkActor {
  accountId: string;
  userId: string;
  canReview: boolean;
  canRaise: boolean;
}

/** May this person send, resend or withdraw the closure form of this case? Review/approve: any case. Raise only: a case they raised. */
export const mayActOnLink = (actor: LinkActor, row: Pick<RequestRow, "created_by">): boolean =>
  actor.canReview || (actor.canRaise && row.created_by !== null && row.created_by === actor.userId);

// ---- reading ---------------------------------------------------------------------------------------------------------------

export const LINK_COLUMNS = "id, request_id, conversation_id, channel, locale, created_by, created_at, expires_at, sent_at, opened_at, submitted_at, revoked_at, revoked_reason";

export interface LinkDbRow {
  id: string;
  request_id: string;
  conversation_id: string | null;
  channel: string | null;
  locale: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  opened_at: string | null;
  submitted_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
}

/** The links of one case, newest first, for the case page (menu.compliance). */
export async function linksOfRequest(admin: SupabaseClient, accountId: string, requestId: string, now: Date = new Date()): Promise<FormLinkView[]> {
  const { data, error } = await admin.from("compliance_form_links").select(LINK_COLUMNS).eq("account_id", accountId).eq("request_id", requestId).order("created_at", { ascending: false }).limit(50);
  if (error) throw complianceError("server_error");
  const people = await loadPeople(admin, accountId);
  return ((data ?? []) as unknown as LinkDbRow[]).map((l) => ({
    id: l.id,
    state: linkState(l, now),
    channel: l.channel,
    locale: l.locale,
    createdAt: l.created_at,
    expiresAt: l.expires_at,
    sentAt: l.sent_at,
    openedAt: l.opened_at,
    submittedAt: l.submitted_at,
    revokedAt: l.revoked_at,
    createdBy: personRef(people, l.created_by),
  }));
}

/**
 * The status of the cards in one conversation, for the Inbox thread: for each link (named by `ids` or all of the conversation's) its state and whether this
 * person may resend or withdraw it. Nothing about the customer. The conversation is one the caller's own session was able to open (the route checks).
 */
export async function cardStatuses(admin: SupabaseClient, actor: LinkActor, conversationId: string, ids: readonly string[] | null, now: Date = new Date()): Promise<CardStatus[]> {
  let q = admin.from("compliance_form_links").select(LINK_COLUMNS).eq("account_id", actor.accountId).eq("conversation_id", conversationId);
  if (ids && ids.length > 0) q = q.in("id", ids.slice(0, 100));
  const { data, error } = await q.order("created_at", { ascending: false }).limit(100);
  if (error) throw complianceError("server_error");
  const links = (data ?? []) as unknown as LinkDbRow[];
  if (links.length === 0) return [];
  const reqIds = Array.from(new Set(links.map((l) => l.request_id)));
  const reqs = await admin.from("compliance_requests").select("id, created_by").eq("account_id", actor.accountId).in("id", reqIds);
  const createdBy = new Map(((reqs.data ?? []) as { id: string; created_by: string | null }[]).map((r) => [r.id, r.created_by]));
  return links.map((l) => {
    const state = linkState(l, now);
    const may = mayActOnLink(actor, { created_by: createdBy.get(l.request_id) ?? null });
    return { id: l.id, state, expiresAt: l.expires_at, canManage: may, ...(may ? { requestId: l.request_id } : {}) };
  });
}
