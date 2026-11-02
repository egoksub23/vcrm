// ============================================================
// `user.typing` (docs/vircle-chat-contract.md, section 3.4): the Vircle user is typing.
//
// Ephemeral by design: nothing is stored and the event id is not remembered.
// The in-memory broadcaster fans out the signal to every open SSE connection
// watching this conversation (VircleTypingIndicator). Replaced Supabase
// Realtime channel.httpSend() in Phase 4 of the Supabase shutdown.
// ============================================================

import type { PgDb } from "@/lib/postgres/db";

import { createSupabaseIdentityStore } from "@/lib/widget/identity-resolve";

import type { TypingEvent } from "./contract";
import { broadcastTyping } from "./typing-broadcaster";

export type TypingResult =
  | { status: "broadcast"; conversationId: string }
  | { status: "unknown_user" };

/**
 * Tell every agent looking at this user's conversation that the user is typing.
 * A user or conversation Halo has not seen yet is silently ignored.
 */
export async function broadcastUserTyping(
  admin: PgDb,
  accountId: string,
  ev: TypingEvent,
): Promise<TypingResult> {
  const contact = await createSupabaseIdentityStore(admin).findByWallet(
    accountId,
    ev.walletId,
  );
  if (!contact) return { status: "unknown_user" };

  const { data, error } = await admin
    .from("conversations")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contact.id)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const conversationId = (
    (data ?? [])[0] as { id: string } | undefined
  )?.id;
  if (!conversationId) return { status: "unknown_user" };

  broadcastTyping(conversationId, { at: new Date().toISOString() });
  return { status: "broadcast", conversationId };
}
