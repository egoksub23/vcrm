import { NextResponse } from 'next/server'

import { getCurrentAccount, requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { TicketCommentError } from '@/lib/tickets/comment-write'
import { isMentionAction, resolveMention } from '@/lib/tickets/mention-resolve'

// PATCH /api/tickets/[id]/mentions/[mentionId]
// Body: { action: 'done' | 'cancel' | 'nudge' }
//   done    the person asked marks it done (any member who can open tickets)
//   cancel  the person who asked withdraws the request   (tickets.work)
//   nudge   the person who asked reminds them, once an hour (tickets.work)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; mentionId: string }> },
) {
  try {
    const payload = (await request.json().catch(() => null)) as { action?: unknown } | null
    if (!isMentionAction(payload?.action)) {
      return NextResponse.json({ error: "action must be 'done', 'cancel' or 'nudge'" }, { status: 400 })
    }
    const ctx = payload.action === 'done' ? await getCurrentAccount() : await requireCapability('tickets.work')
    const { id: ticketId, mentionId } = await params

    const mention = await resolveMention(ctx.supabase, supabaseAdmin(), {
      ticketId,
      mentionId,
      userId: ctx.userId,
      action: payload.action,
    })
    return NextResponse.json({ mention })
  } catch (error) {
    if (error instanceof TicketCommentError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}
