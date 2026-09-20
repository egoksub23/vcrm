import type { SupabaseClient } from '@supabase/supabase-js'
import { KB_LANGUAGES, type KbLanguage } from '@/lib/ai/knowledge-query'
import type { ImportItem } from './import-extract'

// ============================================================
// Saving imported articles. An import ALWAYS lands as drafts, whoever runs
// it: nothing imported reaches the AI or other agents' search until an admin
// has read it and published it.
// ============================================================

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ImportOptions {
  language: KbLanguage
  collectionId: string | null
}

export type ParsedImportOptions = ({ ok: true } & ImportOptions) | { ok: false; error: string }

/** The language and collection an import was asked to file its drafts under. */
export function parseImportOptions(language: unknown, collectionId: unknown): ParsedImportOptions {
  let lang: KbLanguage = 'en'
  if (language !== undefined && language !== null && language !== '') {
    if (typeof language !== 'string' || !(KB_LANGUAGES as readonly string[]).includes(language)) {
      return { ok: false, error: 'language must be en, ms or zh' }
    }
    lang = language as KbLanguage
  }
  let collection: string | null = null
  if (collectionId !== undefined && collectionId !== null && collectionId !== '') {
    if (typeof collectionId !== 'string' || !UUID.test(collectionId)) {
      return { ok: false, error: 'collection_id must be a collection id' }
    }
    collection = collectionId
  }
  return { ok: true, language: lang, collectionId: collection }
}

export type SaveResult =
  | { ok: true; documents: { id: string; title: string }[] }
  | { ok: false; error: string; status: number }

export async function saveImportedDrafts(
  db: SupabaseClient,
  ctx: { accountId: string; userId: string },
  items: ImportItem[],
  opts: ImportOptions & { sourceId?: string | null },
): Promise<SaveResult> {
  const rows = items.map((item) => ({
    account_id: ctx.accountId,
    created_by: ctx.userId,
    updated_by: ctx.userId,
    title: item.title,
    content: item.content,
    content_html: item.content_html,
    kind: item.kind,
    language: opts.language,
    status: 'draft' as const,
    use_in_ai: true,
    collection_id: opts.collectionId,
    source_id: opts.sourceId ?? null,
  }))
  const { data, error } = await db.from('ai_knowledge_documents').insert(rows).select('id, title')
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code
    if (code === '23503') return { ok: false, error: 'That collection no longer exists.', status: 400 }
    if (code === '42501') return { ok: false, error: 'You do not have permission to add articles.', status: 403 }
    console.error('[knowledge import] insert failed:', error)
    return { ok: false, error: 'Failed to save the imported articles', status: 500 }
  }
  return { ok: true, documents: data as { id: string; title: string }[] }
}

/** Record where imported articles came from (a file name or a web address). */
export async function createSource(
  db: SupabaseClient,
  ctx: { accountId: string; userId: string },
  source: { kind: 'file' | 'url'; name: string | null; url?: string | null; checksum: string | null },
): Promise<string | null> {
  const { data, error } = await db
    .from('knowledge_sources')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      kind: source.kind,
      name: source.name,
      url: source.url ?? null,
      checksum: source.checksum,
      last_synced_at: new Date().toISOString(),
      sync_status: 'ok',
    })
    .select('id')
    .single()
  if (error || !data) {
    console.error('[knowledge import] source insert failed:', error)
    return null
  }
  return (data as { id: string }).id
}
