// ============================================================
// POST /api/vircle-chat/typing   body: { conversationId }
//
// An agent is typing to a Vircle Chat user: show "typing..." in the user's app, if it is open
// (docs/vircle-chat-contract.md, section 4.2). The composer calls this freely; Halo passes on at
// most one signal every 3 seconds per agent and conversation and drops the rest quietly.
//
// Same gate as sending (the agent must be able to send messages; the conversation must be a
// Vircle Chat one in the agent's own workspace). The gateway call runs after the answer is sent:
// the composer never waits for it, and a failure only means no "typing..." this time.
// ============================================================
import { NextResponse, after } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { findVircleTarget, openGatewayConnection } from '@/lib/vircle-chat/connection'
import { sendTyping } from '@/lib/vircle-chat/gateway'

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireCapability('messages.send')

    const body = (await request.json().catch(() => null)) as { conversationId?: unknown } | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })

    const target = await findVircleTarget(supabase, accountId, conversationId)
    if (!target) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    // One signal per 3 seconds per agent and conversation; the rest are dropped, not refused.
    const limit = checkRateLimit(`vircle-typing:${userId}:${conversationId}`, RATE_LIMITS.vircleTyping)
    if (!limit.success) return NextResponse.json({ ok: true, throttled: true })

    after(async () => {
      try {
        const conn = await openGatewayConnection(supabaseAdmin(), accountId)
        if (conn) await sendTyping(conn, target.walletId)
      } catch (err) {
        console.error('[vircle-chat] typing signal failed:', err instanceof Error ? err.message : err)
      }
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
