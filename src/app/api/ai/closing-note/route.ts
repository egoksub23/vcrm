import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AiError } from '@/lib/ai/types'
import { buildClosingNotePrompt, parseClosingNote } from '@/lib/ai/wrap-up'
import { outputLanguage, runWrapUpJob } from '@/lib/ai/wrap-up-run'

/**
 * POST /api/ai/closing-note  (agent+)
 * Body: { conversationId, locale? }
 * → { note, label: { id, name } | null }
 *
 * Drafts the note an agent files when closing a chat, plus one suggested
 * label from the account's existing conversation labels (never an invented
 * one, and never one the chat already has). The agent edits before closing,
 * so the required-note rule and the audit trail are unchanged.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireCapability('ai.use')
    const limit = checkRateLimit(`ai-closing:${userId}`, RATE_LIMITS.aiDraft ?? RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { conversationId?: unknown; locale?: unknown } | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })

    // Candidate labels: this account's conversation labels, minus any the
    // chat already carries.
    const [tagsRes, appliedRes] = await Promise.all([
      // Approved labels only: a proposal that waits for a reviewer (migration 084) is never suggested.
      supabase.from('tags').select('id, name').eq('account_id', accountId).eq('for_conversations', true).eq('approval_status', 'approved').limit(200),
      supabase.from('conversation_labels').select('tag_id').eq('conversation_id', conversationId),
    ])
    const applied = new Set((appliedRes.data ?? []).map((r) => r.tag_id as string))
    const labels = (tagsRes.data ?? [])
      .filter((t) => !applied.has(t.id as string))
      .map((t) => ({ id: t.id as string, name: t.name as string }))

    const text = await runWrapUpJob({
      db: supabase,
      admin: supabaseAdmin(),
      accountId,
      conversationId,
      task: 'closing_note',
      systemPrompt: buildClosingNotePrompt({ labels, language: outputLanguage(body?.locale) }),
    })

    const parsed = parseClosingNote(text, labels)
    if (!parsed) {
      return NextResponse.json({ error: 'The AI did not return a note. Write it yourself.', code: 'empty' }, { status: 502 })
    }
    return NextResponse.json({ note: parsed.note, label: parsed.label })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
