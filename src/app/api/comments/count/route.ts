import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/** GET /api/comments/count — comments still waiting for a first response,
 *  for the Comments tab's bubble. */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { count, error } = await supabase
      .from('comments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('direction', 'inbound')
      .eq('handled_status', 'open')
      .neq('status', 'deleted')
    if (error) return NextResponse.json({ open: 0 })
    return NextResponse.json({ open: count ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
