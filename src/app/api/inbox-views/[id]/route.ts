import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Rename / delete a saved inbox view. Like the POST route, this uses the
// service-role client, so ownership has to be checked explicitly: a
// personal view can only be touched by its owner, a shared view (owner_id
// IS NULL) only by admin+.

async function loadOwnedView(id: string, accountId: string) {
  const { data, error } = await supabaseAdmin()
    .from('inbox_views')
    .select('id, owner_id')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as { id: string; owner_id: string | null } | null
}

function canModify(
  view: { owner_id: string | null },
  ctx: { userId: string; role: string },
): boolean {
  if (view.owner_id === null) return ctx.role === 'admin' || ctx.role === 'owner'
  return view.owner_id === ctx.userId
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const view = await loadOwnedView(id, ctx.accountId).catch((err) => {
    console.error('[inbox-views] load failed:', err)
    return null
  })
  if (!view) return NextResponse.json({ error: 'Inbox view not found' }, { status: 404 })
  if (!canModify(view, ctx)) {
    return NextResponse.json({ error: 'Not allowed to edit this view' }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    update.name = name
  }
  if (body.filter_config && typeof body.filter_config === 'object') {
    update.filter_config = body.filter_config
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true })

  const { error } = await supabaseAdmin()
    .from('inbox_views')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const view = await loadOwnedView(id, ctx.accountId).catch((err) => {
    console.error('[inbox-views] load failed:', err)
    return null
  })
  if (!view) return NextResponse.json({ error: 'Inbox view not found' }, { status: 404 })
  if (!canModify(view, ctx)) {
    return NextResponse.json({ error: 'Not allowed to delete this view' }, { status: 403 })
  }

  const { error } = await supabaseAdmin()
    .from('inbox_views')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
