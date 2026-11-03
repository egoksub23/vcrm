// GET /api/conversations/{id}/messages
// Returns all messages for a conversation, ordered oldest-first.
// Uses session auth + PgDb so it reads from the same database that
// the server writes to (the local PostgreSQL on the VPS), not from
// Supabase cloud which no longer receives new inserts.

import { requireCapability } from '@/lib/auth/account';
import { NextResponse } from 'next/server';
import type { Message } from '@/types';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireCapability('messages.send');
    const { id: conversationId } = await params;

    // Verify the conversation belongs to this account.
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[GET /api/conversations/[id]/messages]', error);
      return NextResponse.json({ error: 'internal' }, { status: 500 });
    }

    return NextResponse.json((data ?? []) as Message[]);
  } catch (err) {
    console.error('[GET /api/conversations/[id]/messages] auth error:', err);
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}
