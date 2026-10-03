// ============================================================
// POST /api/vircle-chat/read   body: { conversationId }
//
// An agent opened (or bulk-marked read) a Vircle Chat conversation: tell the gateway which of
// the user's messages are now read, so the app can show the "read" ticks
// (docs/vircle-chat-contract.md, section 4.1). The database has already flipped the messages to
// `read`; this sends the ones the gateway has not been told about yet.
//
// Same gate as sending: the agent must be able to send messages, and the conversation must be a
// Vircle Chat one in the agent's own workspace. Always answers 200 once those hold: a gateway
// that is down leaves the messages pending for the next try, it is not the agent's problem.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { findVircleTarget } from '@/lib/vircle-chat/connection'
import { notifyVircleReads } from '@/lib/vircle-chat/read-receipts'

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireCapability('messages.send')

    const body = (await request.json().catch(() => null)) as { conversationId?: unknown } | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })

    // The caller's own client: the conversation must be one they can see, in their workspace.
    const target = await findVircleTarget(supabase, accountId, conversationId)
    if (!target) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const notified = await notifyVircleReads(supabaseAdmin(), accountId, conversationId)
    return NextResponse.json({ ok: true, notified })
  } catch (err) {
    return toErrorResponse(err)
  }
}
