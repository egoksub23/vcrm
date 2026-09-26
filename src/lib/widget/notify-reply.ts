// ============================================================
// "You have a new reply" email for a web-widget visitor who has
// probably left the page — the cheap, always-available half of the
// WhatsApp-parity notification story (see docs/web-chat-widget.md).
// Real push (Web Push for a real browser tab, native push for a
// mobile app's WebView, which can't use Web Push at all) is bigger,
// separately-scoped follow-on work; this needs no new vendor, no
// permission prompt, and works everywhere — including inside a
// WebView — since it's just email.
//
// Called best-effort, fire-and-forget, from sendMessageToConversation
// after a widget-channel agent/bot reply is persisted. Never throws:
// every failure is caught and logged, since a notification miss must
// never be visible to the agent sending the reply.
//
// Restricted to a VERIFIED identity's email (migration 110's
// email-code flow, or a signed in-app token) — an unverified typed
// claim's email could be a stranger's, and emailing "you have a new
// reply" to it would leak that a conversation exists to whoever typed
// it. See src/lib/widget/identity-resolve.ts's trust tiers.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js';

import { isResendConfigured, sendEmail } from '@/lib/email/resend';

/** Below this, assume the visitor is still looking at the page and
 *  will see the reply arrive live via Realtime — no need to email. */
const ACTIVE_WINDOW_MS = 2 * 60_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function notifyWidgetVisitorOfReply(
  admin: SupabaseClient,
  args: {
    accountId: string;
    conversationId: string;
    contactId: string;
    contactEmail: string | null;
  }
): Promise<void> {
  if (!args.contactEmail || !isResendConfigured()) return;

  try {
    const { data: visitors } = await admin
      .from('widget_visitors')
      .select('identity_level, last_seen_at')
      .eq('contact_id', args.contactId);
    if (!visitors || visitors.length === 0) return;

    // Only a verified browser's email is trusted enough to notify.
    if (!visitors.some((v) => v.identity_level === 'verified')) return;

    const mostRecentSeen = visitors.reduce<number>((max, v) => {
      const seen = v.last_seen_at ? new Date(v.last_seen_at).getTime() : 0;
      return Math.max(max, seen);
    }, 0);
    if (Date.now() - mostRecentSeen < ACTIVE_WINDOW_MS) return;

    const { data: note } = await admin
      .from('widget_reply_notifications')
      .select('notified_at')
      .eq('conversation_id', args.conversationId)
      .maybeSingle();
    // Already notified since the visitor was last seen: don't re-email
    // for every message in the same away period, only the first.
    if (note && new Date(note.notified_at).getTime() >= mostRecentSeen) return;

    await admin
      .from('widget_reply_notifications')
      .upsert(
        {
          conversation_id: args.conversationId,
          account_id: args.accountId,
          notified_at: new Date().toISOString(),
        },
        { onConflict: 'conversation_id' }
      );

    await sendEmail({
      to: args.contactEmail,
      subject: 'You have a new reply',
      html: `<p>${escapeHtml('You have a new reply waiting for you. Reopen the chat to see it.')}</p>`,
      text: 'You have a new reply waiting for you. Reopen the chat to see it.',
    });
  } catch (err) {
    console.error(
      '[widget/notify-reply] failed:',
      err instanceof Error ? err.message : err
    );
  }
}
