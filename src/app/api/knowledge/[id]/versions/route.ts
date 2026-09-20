import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import type { KnowledgeVersion } from '@/lib/knowledge-types'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/knowledge/[id]/versions   (any member)
 *
 * The earlier saved versions of an article, newest first (the database keeps
 * the last 30). The newest snapshot is the article as it is now, so it is left
 * out while it still matches. Returns `{ versions }`.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params

    const { data: doc } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, content, content_html')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!doc) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { data, error } = await supabase
      .from('knowledge_document_versions')
      .select('id, title, content, content_html, edited_by, created_at')
      .eq('account_id', accountId)
      .eq('document_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(30)
    if (error) {
      console.error('[knowledge/versions GET] error:', error)
      return NextResponse.json({ error: 'Failed to load the history' }, { status: 500 })
    }

    let rows = (data ?? []) as {
      id: string
      title: string
      content: string
      content_html: string | null
      edited_by: string | null
      created_at: string
    }[]
    const newest = rows[0]
    if (
      newest &&
      newest.title === doc.title &&
      newest.content === doc.content &&
      (newest.content_html ?? null) === ((doc.content_html as string | null) ?? null)
    ) {
      rows = rows.slice(1)
    }

    const editorIds = Array.from(new Set(rows.map((r) => r.edited_by).filter((x): x is string => !!x)))
    const names = new Map<string, string>()
    if (editorIds.length > 0) {
      const { data: people } = await supabase
        .from('profiles')
        .select('user_id, full_name, email')
        .eq('account_id', accountId)
        .in('user_id', editorIds)
      for (const p of (people ?? []) as { user_id: string; full_name: string | null; email: string | null }[]) {
        names.set(p.user_id, p.full_name?.trim() || p.email || '')
      }
    }

    const versions: KnowledgeVersion[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      edited_by: r.edited_by,
      edited_by_name: r.edited_by ? (names.get(r.edited_by) || null) : null,
      created_at: r.created_at,
    }))
    return NextResponse.json({ versions })
  } catch (err) {
    return toErrorResponse(err)
  }
}
