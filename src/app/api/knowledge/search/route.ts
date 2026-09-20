import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsConfig } from '@/lib/ai/config'
import { searchKnowledge } from '@/lib/ai/knowledge'
import { normalizeLanguage } from '@/lib/ai/knowledge-query'
import { loadEffectiveAttachments } from '@/lib/knowledge/translations'
import type { KnowledgeSearchResult } from '@/lib/knowledge-types'

const MAX_QUERY_CHARS = 600
const SNIPPET_CHARS = 320
const BODY_CHARS = 4000

/** A chunk starts with its article title (see ingestDocument); show the
 *  passage without repeating it. */
function stripTitle(content: string, title: string): string {
  return content.startsWith(`${title}\n\n`) ? content.slice(title.length + 2) : content
}

/**
 * GET /api/knowledge/search?q=…&lang=en|ms|zh&limit=5   (any member)
 *
 * The agents' search: the same retrieval the AI uses, but with no model
 * call, so it is instant and free. Published articles only (agents-only
 * ones included). One result per article (a translation and its base count
 * as one: the customer's language wins), best passage first, with the
 * article's rich text and files so an agent can insert them into a reply.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()
    const limit = checkRateLimit(`kb-search:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS)
    const lang = normalizeLanguage(url.searchParams.get('lang'))
    const n = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5, 1), 10)
    if (!q) return NextResponse.json({ results: [] })

    const { config } = await loadEmbeddingsConfig(supabase, accountId)
    const hits = await searchKnowledge(supabase, accountId, config, q, {
      audience: 'agent',
      k: n * 2,
      language: lang,
    })

    // One row per article: keep its best passage.
    const best = new Map<string, (typeof hits)[number]>()
    for (const h of hits) if (!best.has(h.documentId)) best.set(h.documentId, h)
    const top = Array.from(best.values()).slice(0, n)
    if (top.length === 0) return NextResponse.json({ results: [] })

    const { data: docs } = await supabase
      .from('ai_knowledge_documents')
      .select('id, kind, content, content_html, use_in_ai')
      .in('id', top.map((h) => h.documentId))
    const byId = new Map((docs ?? []).map((d) => [d.id as string, d]))
    // A translation with no files of its own sends its base article's.
    const attachments = await loadEffectiveAttachments(supabase, accountId, top.map((h) => h.documentId))

    return NextResponse.json({
      results: top.map((h): KnowledgeSearchResult => {
        const doc = byId.get(h.documentId)
        return {
          id: h.documentId,
          title: h.title,
          category: h.category,
          language: h.language,
          kind: doc?.kind ?? 'article',
          use_in_ai: doc?.use_in_ai ?? true,
          snippet: stripTitle(h.content, h.title).slice(0, SNIPPET_CHARS),
          body: ((doc?.content as string | undefined) ?? stripTitle(h.content, h.title)).slice(0, BODY_CHARS),
          body_html: (doc?.content_html as string | null | undefined) ?? null,
          via: h.via,
          attachments: attachments.get(h.documentId) ?? [],
        }
      }),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
