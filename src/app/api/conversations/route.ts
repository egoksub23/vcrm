// GET /api/conversations
// Returns all conversations for the current account, ordered newest-first.
// Uses session auth + PgDb so it reads from local PostgreSQL.

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { NextResponse } from 'next/server';
import { CONVERSATION_SELECT, normalizeConversations } from '@/lib/inbox/conversations';

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .order('last_message_at', { ascending: false });
    if (error) {
      console.error('[GET /api/conversations]', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return NextResponse.json(normalizeConversations((data ?? []) as any));
  } catch (err) {
    return toErrorResponse(err);
  }
}
