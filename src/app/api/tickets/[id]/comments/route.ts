import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { TicketCommentError, postTicketComment } from '@/lib/tickets/comment-write'

// POST /api/tickets/[id]/comments
// Body: { body, mentions?: string[] (user ids), teams?: string[] (team ids), kind?: 'response' | 'fyi' }
// Writes the comment as the caller, expands @teams into their members, makes
// them watchers and (kind 'response') records who has to answer. See migration 095.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCapability('tickets.work')
    const { id: ticketId } = await params

    const payload = (await request.json().catch(() => null)) as {
      body?: unknown
      mentions?: unknown
      teams?: unknown
      kind?: unknown
    } | null

    const result = await postTicketComment(ctx.supabase, supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      ticketId,
      body: typeof payload?.body === 'string' ? payload.body : '',
      mentions: Array.isArray(payload?.mentions) ? payload.mentions : [],
      teams: Array.isArray(payload?.teams) ? payload.teams : [],
      kind: payload?.kind === 'fyi' ? 'fyi' : 'response',
    })
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    if (error instanceof TicketCommentError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return toErrorResponse(error)
  }
}
