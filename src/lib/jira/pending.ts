// ============================================================
// The pending Jira sign-in (`oauth_pending_connections`, channel 'jira').
//
// One row per attempt. Its `state` column holds the signed state string, and
// the row is single-use: `consumePending` moves it from 'pending' in ONE
// conditional update, so a replayed callback finds nothing to consume.
// Between the callback and the site picker the tokens sit here encrypted with
// the same key as every other stored token, for at most ten minutes.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt, encrypt } from "@/lib/whatsapp/encryption";

import type { AccessibleSite, TokenSet } from "./oauth";

export interface PendingJira {
  id: string;
  account_id: string;
  initiated_by_user_id: string;
  state: string;
  status: "pending" | "awaiting_page_selection" | "completed" | "expired" | "failed";
  expires_at: string;
  sites: AccessibleSite[];
}

interface Row {
  id: string;
  account_id: string;
  initiated_by_user_id: string;
  state: string;
  status: PendingJira["status"];
  expires_at: string;
  pages_json: AccessibleSite[] | null;
  long_lived_user_token: string | null;
}

const toPending = (r: Row): PendingJira => ({
  id: r.id,
  account_id: r.account_id,
  initiated_by_user_id: r.initiated_by_user_id,
  state: r.state,
  status: r.status,
  expires_at: r.expires_at,
  sites: r.pages_json ?? [],
});

export async function createPending(
  db: SupabaseClient,
  args: { accountId: string; userId: string; state: string },
): Promise<string> {
  const { data, error } = await db
    .from("oauth_pending_connections")
    .insert({ account_id: args.accountId, initiated_by_user_id: args.userId, channel: "jira", state: args.state })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to start the Jira sign-in: ${error?.message ?? "unknown error"}`);
  return (data as { id: string }).id;
}

/** Find a live pending sign-in by its state string. */
export async function findPendingByState(db: SupabaseClient, state: string): Promise<PendingJira | null> {
  const { data } = await db.from("oauth_pending_connections").select("*").eq("channel", "jira").eq("state", state).maybeSingle();
  const r = data as Row | null;
  if (!r || new Date(r.expires_at).getTime() < Date.now()) return null;
  return toPending(r);
}

export async function findPendingById(db: SupabaseClient, id: string): Promise<PendingJira | null> {
  const { data } = await db.from("oauth_pending_connections").select("*").eq("channel", "jira").eq("id", id).maybeSingle();
  const r = data as Row | null;
  if (!r || new Date(r.expires_at).getTime() < Date.now()) return null;
  return toPending(r);
}

/** Claim the callback: only one request can move a row out of 'pending'. */
export async function consumePending(db: SupabaseClient, id: string): Promise<boolean> {
  const { data } = await db
    .from("oauth_pending_connections")
    .update({ status: "awaiting_page_selection" })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  return Array.isArray(data) && data.length === 1;
}

/** Keep the tokens (encrypted) and the site list for the picker. */
export async function storeForPicker(db: SupabaseClient, id: string, tokens: TokenSet, sites: AccessibleSite[]): Promise<void> {
  const blob = encrypt(
    JSON.stringify({ a: tokens.accessToken, r: tokens.refreshToken, e: tokens.expiresAt.toISOString(), s: tokens.scope }),
  );
  await db
    .from("oauth_pending_connections")
    .update({ long_lived_user_token: blob, pages_json: sites, status: "awaiting_page_selection" })
    .eq("id", id);
}

export async function readPendingTokens(db: SupabaseClient, id: string): Promise<TokenSet | null> {
  const { data } = await db.from("oauth_pending_connections").select("long_lived_user_token").eq("id", id).maybeSingle();
  const blob = (data as { long_lived_user_token?: string | null } | null)?.long_lived_user_token;
  if (!blob) return null;
  try {
    const j = JSON.parse(decrypt(blob)) as { a: string; r: string; e: string; s: string | null };
    return { accessToken: j.a, refreshToken: j.r, expiresAt: new Date(j.e), scope: j.s };
  } catch {
    return null;
  }
}

export async function markPendingDone(db: SupabaseClient, id: string, status: "completed" | "failed"): Promise<void> {
  // Whatever happens next, the stored tokens are dropped from this row.
  await db.from("oauth_pending_connections").update({ status, long_lived_user_token: null }).eq("id", id);
}
