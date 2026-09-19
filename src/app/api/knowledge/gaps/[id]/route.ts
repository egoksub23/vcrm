import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/knowledge/gaps/[id]  (agent+)
 * Body: { status: 'resolved' | 'dismissed' | 'open', resolved_document_id? }
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as {
      status?: unknown
      resolved_document_id?: unknown
    } | null
    if (!body || !['open', 'resolved', 'dismissed'].includes(body.status as string)) {
      return NextResponse.json({ error: 'status must be open, resolved or dismissed' }, { status: 400 })
    }
    const update: Record<string, unknown> = { status: body.status }
    if (typeof body.resolved_document_id === 'string') {
      update.resolved_document_id = body.resolved_document_id
    }
    const { data, error } = await supabase
      .from('knowledge_gaps')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      // A re-opened question that already has another open row with the
      // same text hits the unique index; say so plainly.
      const dup = (error as { code?: string }).code === '23505'
      return NextResponse.json(
        { error: dup ? 'This question is already open.' : 'Failed to update' },
        { status: dup ? 409 : 500 },
      )
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
