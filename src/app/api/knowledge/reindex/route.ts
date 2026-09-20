import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsConfig } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

/**
 * POST /api/knowledge/reindex  (admin+)
 *
 * Re-chunk and re-embed every article. Used after setting up (or changing)
 * the embeddings service: existing articles were stored keyword-only, and
 * this backfills their vectors. Also recovers articles whose indexing
 * failed earlier. Drafts are skipped (they are never indexed).
 */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireCapability('knowledge.manage')
    const limit = checkRateLimit(`kb-reindex:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: docs, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, content, status')
      .eq('account_id', accountId)
      .eq('status', 'published')
    if (error) {
      console.error('[knowledge/reindex] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load articles' }, { status: 500 })
    }

    const { config, corrupt } = await loadEmbeddingsConfig(supabase, accountId)
    // The point of Reindex is usually to backfill vectors — don't quietly
    // do a keyword-only pass and report success when a key is unusable.
    if (corrupt) {
      return NextResponse.json({
        success: false,
        reindexed: 0,
        error:
          'Your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key in AI Agents → Setup). Nothing was reindexed.',
      })
    }

    let reindexed = 0
    for (const doc of docs ?? []) {
      try {
        await ingestDocument(supabase, accountId, config, {
          id: doc.id,
          title: doc.title,
          content: doc.content,
          status: 'published',
        })
        reindexed += 1
      } catch (err) {
        const message = err instanceof AiError ? err.message : String(err)
        console.error(`[knowledge/reindex] article ${doc.id} failed:`, message)
        return NextResponse.json({
          success: false,
          reindexed,
          total: (docs ?? []).length,
          error: `Reindexed ${reindexed}, then hit an error: ${message}`,
        })
      }
    }
    return NextResponse.json({ success: true, reindexed })
  } catch (err) {
    return toErrorResponse(err)
  }
}
