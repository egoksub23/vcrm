import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  loadCapabilities,
  requireAnyCapability,
  toErrorResponse,
} from '@/lib/auth/account'
import { approvalErrorResponse } from '@/lib/approvals/server'
import { stripPendingEdit, writeMode } from '@/lib/approvals/rules'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// Quick replies — reusable snippets (plain text or a saved interactive
// message) shared across the account. GET lists; POST creates. Both use
// the caller's own client: the agent-gated RLS policies scope the write to
// the account, and the audit trail (migration 082) needs auth.uid() to
// record who added the snippet (a service-role write would read as "system").
//
// Propose and approve (migration 084): with `snippets.manage` a snippet goes
// live as before; with only `snippets.propose` the route calls the
// propose_snippet RPC and the snippet waits for a reviewer (201 with
// `pending: true`). GET lists what the caller may see (their own proposals
// and, for reviewers, all of them, with the approval columns); `?usable=1`
// returns only approved snippets, which is what every picker must use.

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const canReview = (await loadCapabilities(ctx)).has('approvals.review')
    const usable = new URL(request.url).searchParams.get('usable') === '1'
    // RLS (quick_replies_select) scopes to the caller's account and hides
    // other people's pending / rejected proposals.
    let query = ctx.supabase
      .from('quick_replies')
      .select('*')
      .order('created_at', { ascending: false })
    if (usable) query = query.eq('approval_status', 'approved')
    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // A pending edit is only for its proposer and for reviewers.
    const rows = (data ?? []).map((r) => stripPendingEdit(r, ctx.userId, canReview))
    return NextResponse.json({ quick_replies: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireAnyCapability(['snippets.manage', 'snippets.propose'])
  } catch (err) {
    return toErrorResponse(err)
  }
  const mode = writeMode(ctx.capabilities, 'snippets.manage', 'snippets.propose')

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const kind = body.kind === 'interactive' ? 'interactive' : 'text'
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }

  let content_text: string | null = null
  let interactive_payload: unknown = null

  if (kind === 'interactive') {
    const result = validateInteractivePayload(body.interactive_payload)
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 })
    }
    interactive_payload = body.interactive_payload
  } else {
    const text = typeof body.content_text === 'string' ? body.content_text : ''
    if (!text.trim()) {
      return NextResponse.json(
        { error: 'content_text is required for text quick replies' },
        { status: 400 },
      )
    }
    content_text = text
  }

  if (mode === 'propose') {
    // No direct write: the RPC records a pending proposal and tells the reviewers.
    const { data, error } = await ctx.supabase.rpc('propose_snippet', {
      p_title: title,
      p_kind: kind,
      p_content_text: content_text,
      p_interactive_payload: interactive_payload,
    })
    if (error) return approvalErrorResponse(error)
    const result = (data ?? {}) as { id?: string; mode?: string }
    return NextResponse.json(
      { pending: result.mode !== 'created', id: result.id },
      { status: 201 },
    )
  }

  const { data, error } = await ctx.supabase
    .from('quick_replies')
    .insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      title,
      kind,
      content_text,
      interactive_payload,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ quick_reply: data }, { status: 201 })
}
