import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { pickAgentReply, type ThreadMessage } from '@/lib/knowledge/agent-reply'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/knowledge/gaps/[id]/agent-reply   (any member)
 *
 * The first human reply after the AI handed this question over, for "Save
 * agent reply". Returns `{ text }` (null when nobody has answered yet).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data: gap } = await supabase
      .from('knowledge_gaps')
      .select('id, conversation_id, last_asked_at')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!gap) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!gap.conversation_id) return NextResponse.json({ text: null })

    const { data: messages, error } = await supabase
      .from('messages')
      .select('sender_type, content_type, content_text, is_internal, created_at')
      .eq('conversation_id', gap.conversation_id)
      .eq('sender_type', 'agent')
      .gt('created_at', gap.last_asked_at)
      .order('created_at', { ascending: true })
      .limit(50)
    if (error) {
      console.error('[knowledge/gaps agent-reply] error:', error)
      return NextResponse.json({ error: 'Failed to load the conversation' }, { status: 500 })
    }
    return NextResponse.json({
      text: pickAgentReply((messages ?? []) as ThreadMessage[], gap.last_asked_at as string),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
