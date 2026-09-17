import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Saved inbox views (P1 gap-analysis item) — a named ConversationList
// filter combination. GET lists everything the caller can see (their own
// views + every shared one, per inbox_views_select RLS); POST creates
// either a personal view (default) or a shared one (admin+ only). The
// write path below uses the service-role client (supabaseAdmin), which
// bypasses RLS entirely — so unlike the read path, the shared/admin
// check has to be enforced here explicitly rather than left to the
// inbox_views_insert policy.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('inbox_views')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ inbox_views: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const filterConfig =
    body.filter_config && typeof body.filter_config === 'object' ? body.filter_config : {}
  const shared = body.shared === true

  if (shared && ctx.role !== 'admin' && ctx.role !== 'owner') {
    return NextResponse.json(
      { error: 'Only admins can save a shared inbox view' },
      { status: 403 },
    )
  }

  const { data, error } = await supabaseAdmin()
    .from('inbox_views')
    .insert({
      account_id: ctx.accountId,
      owner_id: shared ? null : ctx.userId,
      name,
      filter_config: filterConfig,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ inbox_view: data }, { status: 201 })
}
