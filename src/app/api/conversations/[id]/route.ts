// GET  /api/conversations/:id  — single conversation row with contact + labels
// PATCH /api/conversations/:id — update status / priority / assigned_agent_id / assigned_team_id

import { requireCapability, toErrorResponse } from '@/lib/auth/account';
import { createAdminPgDb } from '@/lib/postgres/db';
import { CONVERSATION_SELECT, normalizeConversation } from '@/lib/inbox/conversations';
import { NextResponse } from 'next/server';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { accountId } = await requireCapability('messages.send');
    const { id } = await params;
    const admin = createAdminPgDb();
    const { data, error } = await admin
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return NextResponse.json(normalizeConversation(data as any));
  } catch (err) {
    return toErrorResponse(err);
  }
}

const ALLOWED_FIELDS = new Set([
  'status',
  'priority',
  'assigned_agent_id',
  'assigned_team_id',
  'unread_count',
]);

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireCapability('conversations.manage');
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED_FIELDS.has(k)) updates[k] = v;
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'no valid fields' }, { status: 400 });
    }

    const { error } = await supabase
      .from('conversations')
      .update(updates)
      .eq('id', id)
      .eq('account_id', accountId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
