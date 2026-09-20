import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseDocInput } from '@/lib/ai/knowledge-doc'
import { hasMinRole } from '@/lib/auth/roles'
import { parseStagedAttachments } from '@/lib/knowledge/attachments-input'
import { indexArticle, loadCollections, syncAttachments } from '@/lib/knowledge/articles'
import { groupTranslationsByBase } from '@/lib/knowledge/translate'
import type {
  KnowledgeDocSummary,
  KnowledgeLibraryResponse,
} from '@/lib/knowledge-types'

const USE_WINDOW_DAYS = 30
const PAGE = 1000

/** Read every row of a query, a page at a time: the API returns at most a
 *  thousand rows per request, and a library can hold more attachments than
 *  that. */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < 30; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1)
    if (error || !data) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

/**
 * GET /api/knowledge
 *
 * The account's knowledge library (any member): every article with its
 * status, language, collection and how often the AI used it lately, the
 * collections with their article counts, plus whether meaning search is set
 * up. See `KnowledgeLibraryResponse`.
 *
 * Translations are rows of their own (`translation_of` set); each base
 * article lists its translations in `translations`, and its use count and
 * the collection counts leave translations out so an article counts once.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const since = new Date(Date.now() - USE_WINDOW_DAYS * 86_400_000).toISOString()

    const [docsRes, usesRes, answersRes, embedRes, gapsRes, collections, attachmentRows] = await Promise.all([
      supabase
        .from('ai_knowledge_documents')
        .select(
          'id, title, kind, language, status, use_in_ai, category, collection_id, review_by, updated_at, created_by, source_conversation_id, source_id, translation_of, machine_translated, translated_from_at',
        )
        .eq('account_id', accountId)
        .order('updated_at', { ascending: false }),
      supabase.rpc('kb_usage_counts', { p_account_id: accountId, p_since: since }),
      supabase.rpc('kb_ai_answers', { p_account_id: accountId, p_since: since }),
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
      loadCollections(supabase, accountId),
      fetchAll<{ document_id: string }>((from, to) =>
        supabase
          .from('knowledge_attachments')
          .select('document_id')
          .eq('account_id', accountId)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])

    if (docsRes.error) {
      console.error('[knowledge GET] error:', docsRes.error)
      return NextResponse.json({ error: 'Failed to load the knowledge base' }, { status: 500 })
    }

    const uses = new Map<string, number>()
    for (const row of (usesRes.data ?? []) as { document_id: string; uses: number | string }[]) {
      uses.set(row.document_id, Number(row.uses) || 0)
    }
    const attachmentCounts = new Map<string, number>()
    for (const row of attachmentRows) {
      attachmentCounts.set(row.document_id, (attachmentCounts.get(row.document_id) ?? 0) + 1)
    }

    const docs = (docsRes.data ?? []) as Array<
      Record<string, unknown> & {
        id: string
        source_id: string | null
        collection_id: string | null
        translation_of: string | null
        machine_translated: boolean
        translated_from_at: string | null
        updated_at: string
        language: KnowledgeDocSummary['language']
        status: KnowledgeDocSummary['status']
      }
    >
    const translationsByBase = groupTranslationsByBase(docs)

    // Where imported articles came from ('file' | 'url').
    const sourceIds = Array.from(new Set(docs.map((d) => d.source_id).filter((x): x is string => !!x)))
    const sourceKinds = new Map<string, 'file' | 'url'>()
    if (sourceIds.length > 0) {
      const { data: sources } = await supabase
        .from('knowledge_sources')
        .select('id, kind')
        .eq('account_id', accountId)
        .in('id', sourceIds)
      for (const s of (sources ?? []) as { id: string; kind: 'file' | 'url' }[]) sourceKinds.set(s.id, s.kind)
    }

    const perCollection = new Map<string, number>()
    for (const d of docs) {
      if (d.translation_of) continue
      if (d.collection_id) perCollection.set(d.collection_id, (perCollection.get(d.collection_id) ?? 0) + 1)
    }

    const documents: KnowledgeDocSummary[] = docs.map((d) => {
      const { source_id, translated_from_at, ...rest } = d
      void translated_from_at
      const translations = translationsByBase.get(d.id) ?? []
      return {
        ...(rest as unknown as Omit<KnowledgeDocSummary, 'source_kind' | 'ai_uses' | 'attachment_count' | 'translations'>),
        source_kind: source_id ? (sourceKinds.get(source_id) ?? null) : null,
        // A base article is credited with the uses of its translations too:
        // the AI answers a Malay customer from the Malay one.
        ai_uses: translations.reduce((n, t) => n + (uses.get(t.id) ?? 0), uses.get(d.id) ?? 0),
        attachment_count: attachmentCounts.get(d.id) ?? 0,
        translations,
      }
    })

    const body: KnowledgeLibraryResponse = {
      documents,
      collections: collections.map((c) => ({ ...c, article_count: perCollection.get(c.id) ?? 0 })),
      search_mode: embedRes.data?.embeddings_api_key ? 'meaning' : 'keyword',
      use_window_days: USE_WINDOW_DAYS,
      open_gaps: gapsRes.count ?? 0,
      ai_answers_30d: Number(answersRes.data ?? 0) || 0,
    }
    return NextResponse.json(body)
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
 *
 * Body: title, `content_html` (rich text; the plain `content` is derived
 * from it on the server) or `content`, collection_id, attachments, kind,
 * language, use_in_ai, review_by, status, source_conversation_id.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const parsed = parseDocInput(body, { partial: false })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    let attachments = null
    if (body && body.attachments !== undefined) {
      const a = parseStagedAttachments(body.attachments, accountId)
      if (!a.ok) return NextResponse.json({ error: a.error }, { status: 400 })
      attachments = a.items
      if (attachments.some((x) => x.id)) {
        return NextResponse.json({ error: 'A new article cannot have existing attachments.' }, { status: 400 })
      }
    }

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
      if ((error as { code?: string } | null)?.code === '23503') {
        return NextResponse.json({ error: 'That collection no longer exists.' }, { status: 400 })
      }
      console.error('[knowledge POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to save the article' }, { status: 500 })
    }

    if (attachments && attachments.length > 0) {
      const sync = await syncAttachments(supabase, accountId, userId, doc.id, attachments)
      if (!sync.ok) {
        // Don't leave a half-saved article behind: the editor will retry.
        await supabase.from('ai_knowledge_documents').delete().eq('account_id', accountId).eq('id', doc.id)
        return NextResponse.json({ error: sync.error }, { status: sync.status })
      }
    }

    if (status !== 'published') return NextResponse.json({ success: true, id: doc.id, status })

    const warning = await indexArticle(supabase, accountId, {
      id: doc.id,
      title: doc.title,
      content: doc.content,
      status: 'published',
    })
    return NextResponse.json(
      warning ? { success: true, id: doc.id, status, warning } : { success: true, id: doc.id, status },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
