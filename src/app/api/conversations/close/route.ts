import { NextResponse, after } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { closeConversation } from '@/lib/conversations/close'

const MAX_IDS = 200
const NOTE_MAX = 1000

/**
 * POST /api/conversations/close  (conversations.manage)
 * Body: { conversation_ids: string[], note: string }
 * → { succeeded: string[], failed: { id, error }[] }
 *
 * Closes conversations with the required closing note. It is the one
 * server-side place a UI close goes through, so the `conversation_closed`
 * trigger is dispatched exactly once per conversation that was actually open.
 * The close itself runs as the signed-in user (the database checks
 * `conversations.manage` and requires the note); the automations run after the
 * response, so a slow AI step never holds the agent's screen.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireCapability('conversations.manage')
    const body = (await request.json().catch(() => null)) as { conversation_ids?: unknown; note?: unknown } | null
    const ids = Array.isArray(body?.conversation_ids)
      ? Array.from(new Set((body.conversation_ids as unknown[]).filter((x): x is string => typeof x === 'string')))
      : []
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) : ''
    if (ids.length === 0 || ids.length > MAX_IDS) {
      return NextResponse.json({ error: `Send between 1 and ${MAX_IDS} conversation ids` }, { status: 400 })
    }
    if (!note) return NextResponse.json({ error: 'A closure note is required to close a conversation' }, { status: 400 })

    const admin = supabaseAdmin()
    const succeeded: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      try {
        await closeConversation({
          rpcClient: supabase,
          admin,
          accountId,
          conversationId: id,
          note,
          closedBy: { type: 'agent', userId },
          defer: (job) => after(job),
        })
        succeeded.push(id)
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : 'Failed to close' })
      }
    }
    return NextResponse.json({ succeeded, failed }, { status: failed.length > 0 && succeeded.length === 0 ? 400 : 200 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
