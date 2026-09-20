import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEmbeddingsConfig } from '@/lib/ai/config'
import { ingestDocument, type IngestDoc } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import {
  attachmentKindFor,
  type KbAttachmentKind,
  type KnowledgeAttachment,
  type KnowledgeCollection,
  type StagedKnowledgeAttachment,
} from '@/lib/knowledge-types'
import { planAttachmentChanges } from './attachments-input'

// ============================================================
// Shared plumbing for the knowledge API routes: reading an article's files,
// saving the attachment list, and (re)indexing an article for search.
// ============================================================

export const KB_BUCKET = 'chat-media'

export interface AttachmentRow {
  id: string
  document_id: string
  file_name: string
  mime_type: string
  size_bytes: number | string
  kind: string
  storage_path: string
  public_url: string
  send_with_ai: boolean
  position: number
}

export const ATTACHMENT_COLUMNS =
  'id, document_id, file_name, mime_type, size_bytes, kind, storage_path, public_url, send_with_ai, position'

const KINDS: KbAttachmentKind[] = ['image', 'video', 'audio', 'document']

/** A database row in the shape the API contract promises. */
export function toAttachment(row: AttachmentRow): KnowledgeAttachment {
  return {
    id: row.id,
    document_id: row.document_id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    // bigint comes back as a string from PostgREST for very large values.
    size_bytes: Number(row.size_bytes) || 0,
    kind: (KINDS as string[]).includes(row.kind) ? (row.kind as KbAttachmentKind) : 'document',
    url: row.public_url,
    storage_path: row.storage_path,
    send_with_ai: row.send_with_ai,
    position: row.position,
  }
}

/** Attachments for a set of articles, grouped by article id, in order. */
export async function loadAttachments(
  db: SupabaseClient,
  accountId: string,
  documentIds: string[],
): Promise<Map<string, KnowledgeAttachment[]>> {
  const byDoc = new Map<string, KnowledgeAttachment[]>()
  if (documentIds.length === 0) return byDoc
  const { data, error } = await db
    .from('knowledge_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('account_id', accountId)
    .in('document_id', documentIds)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    console.error('[knowledge] attachments load failed:', error)
    return byDoc
  }
  for (const row of (data ?? []) as AttachmentRow[]) {
    const list = byDoc.get(row.document_id) ?? []
    list.push(toAttachment(row))
    byDoc.set(row.document_id, list)
  }
  return byDoc
}

export async function loadCollections(
  supabase: SupabaseClient,
  accountId: string,
): Promise<KnowledgeCollection[]> {
  const { data } = await supabase
    .from('knowledge_collections')
    .select('id, name, color, sort_order')
    .eq('account_id', accountId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  return (data ?? []) as KnowledgeCollection[]
}

export type SyncResult = { ok: true } | { ok: false; error: string; status: number }

/**
 * Make an article's attachments equal the list the editor sent: rows with an
 * `id` are kept (their switch and order may change), rows without one are
 * inserted, and existing rows missing from the list are removed along with
 * their stored files (best-effort: a leftover object is a storage nit, not a
 * failed save). Runs as the caller, so row-level security still decides who
 * may change what.
 */
export async function syncAttachments(
  db: SupabaseClient,
  accountId: string,
  userId: string,
  documentId: string,
  staged: StagedKnowledgeAttachment[],
): Promise<SyncResult> {
  const { data: existing, error: loadErr } = await db
    .from('knowledge_attachments')
    .select('id, storage_path')
    .eq('account_id', accountId)
    .eq('document_id', documentId)
  if (loadErr) {
    console.error('[knowledge] attachment sync load failed:', loadErr)
    return { ok: false, error: 'Failed to save the attachments', status: 500 }
  }
  const rows = (existing ?? []) as { id: string; storage_path: string }[]
  const plan = planAttachmentChanges(rows.map((r) => r.id), staged)
  if (plan.unknownIds.length > 0) {
    return { ok: false, error: 'An attachment in the list does not belong to this article.', status: 400 }
  }

  if (plan.add.length > 0) {
    const { error } = await db.from('knowledge_attachments').insert(
      plan.add.map((a) => ({
        account_id: accountId,
        document_id: documentId,
        file_name: a.file_name,
        mime_type: a.mime_type,
        size_bytes: a.size_bytes,
        kind: attachmentKindFor(a.mime_type),
        storage_path: a.storage_path,
        // Derived here rather than trusted from the client.
        public_url: db.storage.from(KB_BUCKET).getPublicUrl(a.storage_path).data.publicUrl,
        send_with_ai: a.send_with_ai,
        position: a.position,
        created_by: userId,
      })),
    )
    if (error) {
      console.error('[knowledge] attachment insert failed:', error)
      return { ok: false, error: 'Failed to save the attachments', status: error.code === '42501' ? 403 : 500 }
    }
  }

  for (const k of plan.keep) {
    const { error } = await db
      .from('knowledge_attachments')
      .update({ send_with_ai: k.send_with_ai, position: k.position })
      .eq('account_id', accountId)
      .eq('id', k.id)
    if (error) {
      console.error('[knowledge] attachment update failed:', error)
      return { ok: false, error: 'Failed to save the attachments', status: 500 }
    }
  }

  if (plan.removeIds.length > 0) {
    const { error } = await db
      .from('knowledge_attachments')
      .delete()
      .eq('account_id', accountId)
      .eq('document_id', documentId)
      .in('id', plan.removeIds)
    if (error) {
      console.error('[knowledge] attachment delete failed:', error)
      return { ok: false, error: 'Failed to save the attachments', status: 500 }
    }
    const gone = rows.filter((r) => plan.removeIds.includes(r.id)).map((r) => r.storage_path)
    await removeStoredFiles(db, accountId, gone)
  }
  return { ok: true }
}

/**
 * Delete stored files nothing refers to any more. A path still used by
 * another attachment row (the same object can be attached twice) is kept.
 * Best-effort: never throws.
 */
export async function removeStoredFiles(
  db: SupabaseClient,
  accountId: string,
  paths: string[],
): Promise<void> {
  try {
    const unique = Array.from(new Set(paths)).filter((p) => p.startsWith(`account-${accountId}/`))
    if (unique.length === 0) return
    const { data: still } = await db
      .from('knowledge_attachments')
      .select('storage_path')
      .eq('account_id', accountId)
      .in('storage_path', unique)
    const inUse = new Set(((still ?? []) as { storage_path: string }[]).map((r) => r.storage_path))
    const orphans = unique.filter((p) => !inUse.has(p))
    if (orphans.length === 0) return
    const { error } = await db.storage.from(KB_BUCKET).remove(orphans)
    if (error) console.warn('[knowledge] stored file cleanup failed:', error.message)
  } catch (err) {
    console.warn('[knowledge] stored file cleanup failed:', err)
  }
}

/**
 * (Re)index one article for search. Returns a warning to show the user when
 * meaning-search indexing failed or is unavailable (keyword search still
 * works), or null when everything went fine.
 */
export async function indexArticle(
  db: SupabaseClient,
  accountId: string,
  doc: IngestDoc,
): Promise<string | null> {
  const { config, corrupt } = await loadEmbeddingsConfig(db, accountId)
  try {
    await ingestDocument(db, accountId, config, doc)
  } catch (err) {
    const message = err instanceof AiError ? err.message : 'indexing failed'
    console.error('[knowledge] ingest error:', err)
    return `Saved, but meaning-search indexing failed (${message}). Keyword search still works; use Reindex to retry.`
  }
  if (corrupt) {
    return 'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).'
  }
  return null
}
