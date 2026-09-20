// ============================================================
// Matching Vircle members to Jira users (jira_user_map).
//
// Automatic: by email, and only when Jira itself shows that email in the
// search result (some sites hide it, in which case nothing is guessed).
// Manual: an admin, or a member for themselves, picks the Jira user.
// A member without a match still works: their comments go out with their
// name in the text, and assigning an issue to them is skipped.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import type { JiraClient } from "./client";
import type { JiraStore } from "./store";

export interface MemberLite {
  user_id: string;
  email: string | null;
  full_name: string | null;
}

export interface JiraUserCandidate {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  accountType?: string;
}

/** The one candidate that is exactly this email, active, and a real person; else null. */
export function pickEmailMatch(email: string, candidates: readonly JiraUserCandidate[]): JiraUserCandidate | null {
  const want = email.trim().toLowerCase();
  if (!want) return null;
  const exact = candidates.filter(
    (c) => c.emailAddress?.trim().toLowerCase() === want && c.active !== false && (!c.accountType || c.accountType === "atlassian"),
  );
  return exact.length === 1 ? exact[0] : null;
}

/** Try to match every unmapped member by email. Bounded: at most 40 lookups a run. */
export async function autoMatchMembers(args: {
  db: SupabaseClient;
  store: JiraStore;
  client: Pick<JiraClient, "searchUsers">;
  accountId: string;
  limit?: number;
}): Promise<{ matched: number; tried: number }> {
  const { db, store, client, accountId } = args;
  const [{ data: members }, mapped] = await Promise.all([
    db.from("profiles").select("user_id, email, full_name").eq("account_id", accountId),
    store.listUserMap(accountId),
  ]);
  const done = new Set(mapped.map((m) => m.user_id));
  const takenJira = new Set(mapped.map((m) => m.jira_account_id));
  let matched = 0;
  let tried = 0;
  for (const m of ((members as MemberLite[] | null) ?? []).filter((x) => !done.has(x.user_id) && x.email)) {
    if (tried >= (args.limit ?? 40)) break;
    tried += 1;
    const found = (await client.searchUsers(m.email as string)) ?? [];
    const hit = pickEmailMatch(m.email as string, found.map((u) => ({ ...u, displayName: u.displayName ?? "" })));
    if (!hit || takenJira.has(hit.accountId)) continue;
    const { error } = await db.from("jira_user_map").insert({
      account_id: accountId,
      user_id: m.user_id,
      jira_account_id: hit.accountId,
      jira_display_name: hit.displayName || null,
      method: "email",
    });
    if (!error) {
      matched += 1;
      takenJira.add(hit.accountId);
    }
  }
  return { matched, tried };
}
