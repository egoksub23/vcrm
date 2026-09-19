import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsConfig } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { parseDocInput } from '@/lib/ai/knowledge-doc'
import { AiError } from '@/lib/ai/types'
import { hasMinRole } from '@/lib/auth/roles'

const USE_WINDOW_DAYS = 30

/**
 * GET /api/knowledge
 *
 * The account's knowledge library (any member): every article with its
 * status, language and how often the AI used it lately, plus whether
 * meaning search is set up.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const [docsRes, usesRes, embedRes, gapsRes] = await Promise.all([
      supabase
        .from('ai_knowledge_documents')
        .select(
          'id, title, kind, language, status, use_in_ai, category, review_by, updated_at, created_by, source_conversation_id',
        )
        .eq('account_id', accountId)
        .order('updated_at', { ascending: false }),
      supabase
        .from('ai_knowledge_citations')
        .select('document_id')
        .eq('account_id', accountId)
        .gte('created_at', new Date(Date.now() - USE_WINDOW_DAYS * 86_400_000).toISOString())
        .limit(20000),
      supabase
        .from('ai_configs')
        .select('embeddings_api_key')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('knowledge_gaps')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('status', 'open'),
    ])

    if (docsRes.error) {
      console.error('[knowledge GET] error:', docsRes.error)
      return NextResponse.json({ error: 'Failed to load the knowledge base' }, { status: 500 })
    }

    const uses = new Map<string, number>()
    for (const row of usesRes.data ?? []) {
      const id = row.document_id as string
      uses.set(id, (uses.get(id) ?? 0) + 1)
    }

    return NextResponse.json({
      documents: (docsRes.data ?? []).map((d) => ({ ...d, ai_uses: uses.get(d.id as string) ?? 0 })),
      search_mode: embedRes.data?.embeddings_api_key ? 'meaning' : 'keyword',
      use_window_days: USE_WINDOW_DAYS,
      open_gaps: gapsRes.count ?? 0,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/knowledge  (agent+)
 *
 * Add an article. Admins can publish straight away; an agent's article is
 * always saved as a draft for an admin to review and publish, so nothing
 * an agent writes reaches the AI (or other agents' search) unreviewed.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const parsed = parseDocInput(await request.json().catch(() => null), { partial: false })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const isAdmin = hasMinRole(role, 'admin')
    const status = isAdmin ? (parsed.fields.status ?? 'published') : 'draft'

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({
        language: 'en',
        ...parsed.fields,
        status,
        account_id: accountId,
        created_by: userId,
        updated_by: userId,
      })
      .select('id, title, content, status')
      .single()
    if (error || !doc) {
      console.error('[knowledge POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to save the article' }, { status: 500 })
    }

    if (status !== 'published') return NextResponse.json({ success: true, id: doc.id, status })

    const { config, corrupt } = await loadEmbeddingsConfig(supabase, accountId)
    try {
      await ingestDocument(supabase, accountId, config, {
        id: doc.id,
        title: doc.title,
        content: doc.content,
        status: 'published',
      })
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[knowledge POST] ingest error:', err)
      return NextResponse.json({
        success: true,
        id: doc.id,
        status,
        warning: `Saved, but meaning-search indexing failed (${message}). Keyword search still works; use Reindex to retry.`,
      })
    }
    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        status,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({ success: true, id: doc.id, status })
  } catch (err) {
    return toErrorResponse(err)
  }
}
