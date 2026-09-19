import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { AiError } from '@/lib/ai/types'
import { buildSummaryPrompt, cleanSummary } from '@/lib/ai/wrap-up'
import { outputLanguage, runWrapUpJob } from '@/lib/ai/wrap-up-run'

/**
 * POST /api/ai/summary  (agent+)
 * Body: { conversationId, locale? }  → { summary }
 *
 * A short summary of the conversation for whoever is picking it up. Shown
 * in place and not stored.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`ai-summary:${userId}`, RATE_LIMITS.aiDraft ?? RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { conversationId?: unknown; locale?: unknown } | null
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 })

    const text = await runWrapUpJob({
      db: supabase,
      admin: supabaseAdmin(),
      accountId,
      conversationId,
      task: 'summary',
      systemPrompt: buildSummaryPrompt({ language: outputLanguage(body?.locale) }),
    })

    const summary = cleanSummary(text)
    if (!summary) return NextResponse.json({ error: 'The AI did not return a summary.', code: 'empty' }, { status: 502 })
    return NextResponse.json({ summary })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    return toErrorResponse(err)
  }
}
