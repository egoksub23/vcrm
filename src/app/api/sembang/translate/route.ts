// ============================================================
// POST /api/sembang/translate
//
//   Body: { messageId: string; targetLanguage?: string }
//   Returns: { translation: string }
//
//   Uses the account's AI config (same loadAiConfig + generateReply
//   pattern as the AI bot reply). Falls back to 503 if AI is not
//   configured for this account.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability('menu.sembang')

    const body = (await request.json().catch(() => null)) as {
      messageId?: unknown
      targetLanguage?: unknown
    } | null

    if (typeof body?.messageId !== 'string' || !body.messageId) {
      return NextResponse.json({ error: 'messageId is required' }, { status: 400 })
    }
    const messageId = body.messageId
    const targetLanguage =
      typeof body?.targetLanguage === 'string' && body.targetLanguage.trim()
        ? body.targetLanguage.trim()
        : 'English'

    // Fetch the message text (account-scoped)
    const { data: row, error: fetchErr } = await ctx.supabase
      .from('sembang_messages')
      .select('body')
      .eq('id', messageId)
      .eq('account_id', ctx.accountId)
      .is('deleted_at', null)
      .maybeSingle()

    if (fetchErr) {
      console.error('[POST /api/sembang/translate] fetch error:', fetchErr)
      return NextResponse.json({ error: 'Failed to fetch message' }, { status: 500 })
    }
    if (!row || !row.body) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    const config = await loadAiConfig(ctx.supabase, ctx.accountId, { requireActive: true })
    if (!config) {
      return NextResponse.json(
        { error: 'AI is not configured for this account' },
        { status: 503 },
      )
    }

    const { text } = await generateReply({
      config,
      systemPrompt: `You are a translation assistant. Translate the user's message to ${targetLanguage}. Return ONLY the translated text — no explanation, no quotes, no preamble.`,
      messages: [{ role: 'user', content: row.body }],
    })

    if (!text) {
      return NextResponse.json({ error: 'Translation returned empty' }, { status: 500 })
    }

    return NextResponse.json({ translation: text })
  } catch (err) {
    return toErrorResponse(err)
  }
}
