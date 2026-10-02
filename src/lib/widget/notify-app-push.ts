// ============================================================
// Placeholder for the Vircle push API: an alert to a customer's phone that a
// reply is waiting. No-ops today because the push API's details (endpoint,
// authentication, payload, error contract) have not been provided yet; this is
// the single place that call will go.
//
// The push API takes a PHONE NUMBER or an EMAIL as the recipient and finds the
// right user and device itself (owner, 2 Oct 2026), so the callers pass what the
// contact has. Two callers:
//   - the web widget (send-message.ts, after an agent or bot reply), keyed today
//     by `contacts.wallet_id`;
//   - Vircle Chat (send-message.ts), when the gateway could only queue the message
//     (docs/vircle-chat-contract.md, section 7).
//
// Mirrors notify-reply.ts's contract exactly (same fire-and-forget usage from
// sendMessageToConversation): never throws, called best-effort after the reply is
// persisted, and must never add latency to or fail that send. When it is built it
// also owns the "at most once per conversation per away period" rule that the
// widget's email already follows.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PushAlertArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  walletId: string | null;
  /** The contact's phone and email: the push API's recipient keys. */
  phone?: string | null;
  email?: string | null;
  /** Which channel raised the alert; defaults to the web widget. */
  source?: 'web_widget' | 'vircle_chat';
}

export async function notifyAppUserOfReplyViaPush(_admin: SupabaseClient, args: PushAlertArgs): Promise<void> {
  const hasRecipient = !!(args.walletId || args.phone || args.email);
  // Nothing to notify without a way to name the person: the overwhelming
  // majority of widget conversations (a website visitor, not the app) hit this
  // every time, by design.
  if (!hasRecipient) return;

  // TODO: call the Vircle push API here once its details are provided, with the phone
  // (else the email) as the recipient key, generic text and a deep link, and only when
  // the workspace turned "Push alerts from Halo" on for Vircle Chat.
}
