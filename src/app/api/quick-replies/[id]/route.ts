import { NextResponse } from 'next/server'
import { requireAnyCapability, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { approvalErrorResponse } from '@/lib/approvals/server'
import { writeMode } from '@/lib/approvals/rules'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// Update / delete a single quick reply. Quick replies are account-
// shared: every mutation is scoped by `account_id` and goes through the
// caller's own client (agent-gated RLS), so the audit trail (migration 082)
// records who changed or removed it. A delete is a soft delete: the
// database keeps the row (deleted_at) so it can be restored.
//
// Propose and approve (migration 084): PATCH with only `snippets.propose`
// stores the change as a pending edit through the propose_snippet_edit RPC
// (the live snippet is unchanged until a reviewer approves); with
// `snippets.manage` it applies at once. DELETE needs `snippets.manage`.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireAnyCapability(['snippets.manage', 'snippets.propose'])
  } catch (err) {
    return toErrorResponse(err)
  }
  const mode = writeMode(ctx.capabilities, 'snippets.manage', 'snippets.propose')

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if (typeof body.title === 'string') {
    const title = body.title.trim()
    if (!title) return NextResponse.json({ error: 'title cannot be empty' }, { status: 400 })
    update.title = title
  }

  // When `kind` is supplied (e.g. the editor flips Text ↔ Interactive), it
  // drives which content column is authoritative and the other is cleared —
  // otherwise a switched row keeps a stale payload the picker mis-routes on.
  if ('kind' in body) {
    if (body.kind !== 'text' && body.kind !== 'interactive') {
      return NextResponse.json({ error: 'kind must be "text" or "interactive"' }, { status: 400 })
    }
    update.kind = body.kind
    if (body.kind === 'interactive') {
      const result = validateInteractivePayload(body.interactive_payload)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
      update.interactive_payload = body.interactive_payload
      update.content_text = null
    } else {
      const text = typeof body.content_text === 'string' ? body.content_text : ''
      if (!text.trim()) {
        return NextResponse.json(
          { error: 'content_text is required for text quick replies' },
          { status: 400 },
        )
      }
      update.content_text = text
      update.interactive_payload = null
    }
  } else {
    // No kind change — allow partial edits of whichever field the row uses.
    if ('content_text' in body) update.content_text = body.content_text ?? null
    if ('interactive_payload' in body) {
      if (body.interactive_payload != null) {
        const result = validateInteractivePayload(body.interactive_payload)
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 })
        }
      }
      update.interactive_payload = body.interactive_payload ?? null
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true })
  }

  if (mode === 'propose') {
    const { data, error } = await ctx.supabase.rpc('propose_snippet_edit', {
      p_id: id,
      p_patch: update,
    })
    if (error) return approvalErrorResponse(error)
    const result = (data ?? {}) as { mode?: string }
    return NextResponse.json({ ok: true, pending: result.mode !== 'updated' })
  }

  const { error } = await ctx.supabase
    .from('quick_replies')
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
    ctx = await requireCapability('snippets.manage')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await ctx.supabase
    .from('quick_replies')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
