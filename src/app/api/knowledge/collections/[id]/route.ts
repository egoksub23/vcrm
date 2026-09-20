import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { parseCollectionInput } from '@/lib/knowledge/collections'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/knowledge/collections/[id]  (admin)
 * Body: { name?, color?, sort_order? }. Renaming also renames the category
 * kept on the collection's articles (a database trigger does that).
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireCapability('knowledge.manage')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const parsed = parseCollectionInput(await request.json().catch(() => null), { partial: true })
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await supabase
      .from('knowledge_collections')
      .update(parsed.fields)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, name, color, sort_order')
      .maybeSingle()
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'A collection with that name already exists.' }, { status: 409 })
      }
      console.error('[knowledge/collections PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update the collection' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true, collection: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/knowledge/collections/[id]  (admin)
 * The collection's articles are kept and become uncategorised.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireCapability('knowledge.manage')
    const limit = checkRateLimit(`kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const { count } = await supabase
      .from('ai_knowledge_documents')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('collection_id', id)

    const { data, error } = await supabase
      .from('knowledge_collections')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[knowledge/collections DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete the collection' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true, unfiled: count ?? 0 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
