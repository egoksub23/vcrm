// GET /api/conversations/pending-delete-count
// Returns the count of messages with pending_delete=true for this account.

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error } = await (supabase as any)
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('pending_delete', true);
    if (error) return NextResponse.json({ count: 0 }, { status: 200 });
    return NextResponse.json({ count: count ?? 0 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
