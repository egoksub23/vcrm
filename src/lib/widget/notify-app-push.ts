// ============================================================
// Placeholder for native push (FCM/APNs/Huawei Push Kit) to a Vircle
// mobile-app chat user, keyed by `contacts.wallet_id` — see
// docs/web-chat-widget.md, "Embedding in a native app". No-ops today:
// there is no push API to call yet, so this only exists as the single
// place that call will go once one is provided.
//
// This is for the WEB WIDGET only. Vircle Chat pushes are the gateway's job:
// the gateway alone decides between a live socket and a push and calls the
// Vircle push API itself; Halo never sends a push for Vircle Chat
// (docs/vircle-chat-contract.md, section 7).
//
// Mirrors notify-reply.ts's contract exactly (same call site, same
// fire-and-forget usage from sendMessageToConversation): never throws,
// called best-effort after a widget-channel agent/bot reply is
// persisted, and must never add latency to or fail that send.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js';

export async function notifyAppUserOfReplyViaPush(
  _admin: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    contactId: string;
    walletId: string | null;
  }
): Promise<void> {
  // Nothing to notify without a wallet id — the overwhelming majority of
  // widget conversations (a website visitor, not the app) will hit this
  // every time, by design.
  if (!args.walletId) return;

  // TODO: call the account's push API here once available, passing
  // args.walletId as the recipient key (per the user's own push-API
  // design — see this module's doc comment).
}
