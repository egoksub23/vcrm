// Temporary diagnostic endpoint — REMOVE after investigation.
// GET /api/debug/vircle-state  →  messages in local PG for the Vircle Chat conversation.

import { createAdminPgDb } from '@/lib/postgres/db';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  try {
    const admin = createAdminPgDb();
    const { searchParams } = new URL(request.url);
    const convId = searchParams.get('convId');

    // If ?convId= is provided, dump everything for that one conversation.
    if (convId) {
      const { data: msgs, error: msgsErr } = await admin
        .from('messages')
        .select('id, sender_type, channel_type, content_text, created_at, status, message_id')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: false })
        .limit(30);
      const { data: conv, error: convErr } = await admin
        .from('conversations')
        .select('id, contact_id, last_message_at, last_message_text, last_channel_type, account_id')
        .eq('id', convId)
        .maybeSingle();
      return NextResponse.json({ conv, convErr, msgs, msgsErr, msgCount: msgs?.length ?? 0 });
    }

    // Latest 20 messages across ALL conversations, ordered newest-first.
    const { data: recentMsgs, error: recentErr } = await admin
      .from('messages')
      .select('id, conversation_id, sender_type, channel_type, content_text, created_at, status')
      .order('created_at', { ascending: false })
      .limit(20);

    // Conversation list sorted by last_message_at.
    const { data: convs, error: convErr } = await admin
      .from('conversations')
      .select('id, contact_id, last_message_at, last_message_text, last_channel_type')
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

    // vircle_chat_config.last_error — set by the webhook on any ingestInbound failure.
    const { data: cfgRows } = await admin
      .from('vircle_chat_config')
      .select('account_id, last_error, updated_at')
      .not('last_error', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(5);

    return NextResponse.json({
      recentMessages: recentMsgs,
      recentMsgsError: recentErr,
      conversations: convs,
      convsError: convErr,
      messageCounts: counts,
      webhookErrors: cfgRows,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
