// POST /api/messages/:id/trash
// Soft-flags a message for pending deletion (migration 062).
// The agent reviews flagged messages in the Pending Delete panel.

import { requireCapability, toErrorResponse } from '@/lib/auth/account';
import { NextResponse } from 'next/server';

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireCapability('messages.send');
    const { id: messageId } = await params;

    // Verify the message belongs to a conversation in this account.
    const { data: msg } = await supabase
      .from('messages')
      .select('id, conversation:conversations!inner(id, account_id)')
      .eq('id', messageId)
      .maybeSingle();

    if (!msg) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conv = (msg as any).conversation;
    if (!conv || conv.account_id !== accountId) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    const { error } = await supabase
      .from('messages')
      .update({ pending_delete: true, pending_delete_at: new Date().toISOString() })
      .eq('id', messageId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
