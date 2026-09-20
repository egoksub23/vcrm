import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadCollections } from '@/lib/knowledge/articles'
import { DEFAULT_COLLECTION_COLOR, parseCollectionInput } from '@/lib/knowledge/collections'
import type { KnowledgeCollection } from '@/lib/knowledge-types'

/** GET /api/knowledge/collections — `{ collections }` with article counts (any member). */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const collections = await loadCollections(supabase, accountId)

    const counts = new Map<string, number>()
    const { data: docs } = await supabase
      .from('ai_knowledge_documents')
      .select('collection_id')
      .eq('account_id', accountId)
      .not('collection_id', 'is', null)
      // A translation is the same article in another language: count it once.
      .is('translation_of', null)
      .limit(20000)
    for (const d of (docs ?? []) as { collection_id: string }[]) {
      counts.set(d.collection_id, (counts.get(d.collection_id) ?? 0) + 1)
    }
    const withCounts: KnowledgeCollection[] = collections.map((c) => ({
      ...c,
      article_count: counts.get(c.id) ?? 0,
    }))
    return NextResponse.json({ collections: withCounts })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/knowledge/collections  (admin)
 * Body: { name, color?, sort_order? }. Returns the new collection (its fields
 * at the top level, and also under `collection`).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const parsed = parseCollectionInput(await request.json().catch(() => null), { partial: false })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    let sortOrder = parsed.fields.sort_order
    if (sortOrder === undefined) {
      // New collections go to the end.
      const { data: last } = await supabase
        .from('knowledge_collections')
        .select('sort_order')
        .eq('account_id', accountId)
        .order('sort_order', { ascending: false })
        .limit(1)
        .maybeSingle()
      sortOrder = ((last?.sort_order as number | undefined) ?? -1) + 1
    }

    const { data, error } = await supabase
      .from('knowledge_collections')
      .insert({
        account_id: accountId,
        name: parsed.fields.name,
        color: parsed.fields.color ?? DEFAULT_COLLECTION_COLOR,
        sort_order: sortOrder,
      })
      .select('id, name, color, sort_order')
      .single()
    if (error || !data) {
      if ((error as { code?: string } | null)?.code === '23505') {
        return NextResponse.json({ error: 'A collection with that name already exists.' }, { status: 409 })
      }
      console.error('[knowledge/collections POST] error:', error)
      return NextResponse.json({ error: 'Failed to create the collection' }, { status: 500 })
    }
    const collection: KnowledgeCollection = { ...(data as KnowledgeCollection), article_count: 0 }
    return NextResponse.json({ ...collection, collection }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
