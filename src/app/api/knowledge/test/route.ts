import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsConfig } from '@/lib/ai/config'
import { searchKnowledge } from '@/lib/ai/knowledge'
import { detectLanguage, normalizeLanguage } from '@/lib/ai/knowledge-query'
import { toTestResponse } from '@/lib/knowledge/test-search'

const MAX_QUESTION_CHARS = 600

/**
 * POST /api/knowledge/test   (any member)
 * Body: { question, language? }
 *
 * "Would the AI find this?": the same retrieval the AI uses (published,
 * AI-enabled articles only), except that passages that matched but fell
 * under the relevance cut-off are also returned, marked `used: false`.
 * Read-only and it calls no model; it does embed the question when meaning
 * search is set up, so it is rate-limited.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    const limit = checkRateLimit(`kb-test:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { question?: unknown; language?: unknown } | null
    const question = typeof body?.question === 'string' ? body.question.trim().slice(0, MAX_QUESTION_CHARS) : ''
    if (!question) return NextResponse.json({ error: 'question is required' }, { status: 400 })
    const language =
      typeof body?.language === 'string' ? normalizeLanguage(body.language) : detectLanguage(question)

    const { config } = await loadEmbeddingsConfig(supabase, accountId)
    const hits = await searchKnowledge(supabase, accountId, config, question, {
      audience: 'ai',
      k: 5,
      language,
      includeBelowCutoff: true,
    })
    return NextResponse.json(toTestResponse(hits, config.embeddingsApiKey ? 'meaning' : 'keyword'))
  } catch (err) {
    return toErrorResponse(err)
  }
}
