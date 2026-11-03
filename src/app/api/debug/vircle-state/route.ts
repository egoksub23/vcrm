// Temporary diagnostic endpoint — REMOVE after investigation.
// GET /api/debug/vircle-state  →  messages in local PG for the Vircle Chat conversation.

import { createAdminPgDb } from '@/lib/postgres/db';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const admin = createAdminPgDb();

    // Latest 10 messages across ALL conversations for this account,
    // ordered by created_at desc — lets us see if any new messages landed anywhere.
    const { data: recentMsgs, error: recentErr } = await admin
      .from('messages')
      .select('id, conversation_id, sender_type, channel_type, content_text, created_at, status')
      .order('created_at', { ascending: false })
      .limit(20);

    // Conversation list — rows sorted by last_message_at so we can see which
    // conversation is receiving activity in local PG.
    const { data: convs, error: convErr } = await admin
      .from('conversations')
      .select('id, contact_id, last_message_at, last_message_text, last_channel_type, channel_type')
      .order('last_message_at', { ascending: false })
      .limit(10);

    // Count messages per conversation for the most recently active ones.
    const counts: Record<string, number> = {};
    if (convs) {
      for (const c of convs.slice(0, 5)) {
        const { count } = await admin
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', c.id);
        counts[c.id] = count ?? 0;
      }
    }

    return NextResponse.json({
      recentMessages: recentMsgs,
      recentMsgsError: recentErr,
      conversations: convs,
      convsError: convErr,
      messageCounts: counts,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
