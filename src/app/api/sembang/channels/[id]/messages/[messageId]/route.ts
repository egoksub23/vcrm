// ============================================================
// /api/sembang/channels/[id]/messages/[messageId]
//
//   PATCH — body `{ action: 'edit', body: string } | { action: 'remove' }`.
//
//           `edit` — author-only (RLS: `sembang_messages_edit_own`):
//           `UPDATE ... SET body = ?, edited_at = now()`. Same 1–8000
//           char validation as POST.
//
//           `remove` — soft-delete (`deleted_at`/`deleted_by`). Works
//           for EITHER the author deleting their own message OR a
//           moderator/admin removing someone else's — two separate
//           permissive RLS policies (migration 099) now cover this; the
//           route doesn't need to know which one applied, it just
//           attempts the UPDATE and lets RLS sort it out. A 0-row update
//           either way is reported as 403.
//
//           `action` omitted (or anything other than `'edit'`) defaults
//           to `remove` — the P0 shape of this route had no body at all,
//           and this keeps that caller working even though the frontend
//           now always passes `action` explicitly.
//
// Returns `{ message: SembangMessage }` (hydrated) on success, for
// either action.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { hydrateMessages, type SembangMessageRow } from '@/lib/sembang/hydrate-messages'

const BODY_MAX = 8000

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const { id: channelId, messageId } = await params

    const payload = (await request.json().catch(() => null)) as {
      action?: unknown
      body?: unknown
    } | null

    if (payload?.action === 'edit') {
      const newBody = typeof payload?.body === 'string' ? payload.body.trim() : ''
      if (!newBody || newBody.length > BODY_MAX) {
        return NextResponse.json(
          { error: `Message must be between 1 and ${BODY_MAX} characters` },
          { status: 400 },
        )
      }

      const { data, error } = await ctx.supabase
        .from('sembang_messages')
        .update({ body: newBody, edited_at: new Date().toISOString() })
        .eq('id', messageId)
        .eq('channel_id', channelId)
        .select('*')
        .maybeSingle()

      if (error) {
        console.error('[PATCH /api/sembang/channels/[id]/messages/[messageId]] edit error:', error)
        return NextResponse.json({ error: 'Failed to edit message' }, { status: 500 })
      }
      if (!data) {
        return NextResponse.json(
          { error: 'You do not have permission to edit this message' },
          { status: 403 },
        )
      }

      const [message] = await hydrateMessages(ctx.supabase, [data as SembangMessageRow], ctx.userId)
      return NextResponse.json({ message })
    }

    // action === 'remove', or omitted entirely (P0 back-compat default).
    const { data, error } = await ctx.supabase
      .from('sembang_messages')
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.userId })
      .eq('id', messageId)
      .eq('channel_id', channelId)
      .select('*')
      .maybeSingle()

    if (error) {
      console.error('[PATCH /api/sembang/channels/[id]/messages/[messageId]] remove error:', error)
      return NextResponse.json({ error: 'Failed to remove message' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'You do not have permission to remove this message' },
        { status: 403 },
      )
    }

    const [message] = await hydrateMessages(ctx.supabase, [data as SembangMessageRow], ctx.userId)
    return NextResponse.json({ message })
  } catch (err) {
    return toErrorResponse(err)
  }
}
