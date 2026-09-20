import type { SupabaseClient } from '@supabase/supabase-js'
import type { KnowledgeAttachment, KnowledgeTranslationBase } from '@/lib/knowledge-types'
import type { KbLanguage } from '@/lib/ai/knowledge-query'
import type { KbStatus } from '@/lib/ai/knowledge-doc'
import { loadAttachments } from './articles'
import { pickEffectiveAttachments, planAttachmentSources, type TranslationRow } from './translate'

// ============================================================
// Knowledge-base translations, the database half: which files an answer
// sends (a translation falls back to its base's), reading a base's
// translations or a translation's base, and keeping translations current
// when the base is saved without a text change. The rules themselves live in
// ./translate (pure, tested).
// ============================================================

/**
 * The files each of these articles sends, in the order given. A translation
 * uses its OWN files when it has any and otherwise its base article's (files
 * are never copied: removing an attachment deletes its stored object, so two
 * rows must not share one). An article whose translation group already
 * appeared earlier in the list is left out, so a translation and its base
 * never both send their files. This is every file: the caller applies the
 * "send with AI answers" switch when it needs to.
 *
 * Works with any client (the service role in the auto-reply bot, the agent's
 * own in the routes). A failed lookup of the links degrades to "no
 * translations", i.e. each article's own files.
 */
export async function loadEffectiveAttachments(
  db: SupabaseClient,
  accountId: string,
  documentIds: string[],
): Promise<Map<string, KnowledgeAttachment[]>> {
  if (documentIds.length === 0) return new Map()

  const parents = new Map<string, string | null>()
  try {
    const { data, error } = await db
      .from('ai_knowledge_documents')
      .select('id, translation_of')
      .eq('account_id', accountId)
      .in('id', documentIds)
    if (error) console.error('[knowledge translations] parent lookup failed:', error)
    for (const row of (data ?? []) as { id: string; translation_of: string | null }[]) {
      parents.set(row.id, row.translation_of ?? null)
    }
  } catch (err) {
    console.error('[knowledge translations] parent lookup failed:', err)
  }

  const plan = planAttachmentSources(documentIds, parents)
  const needed = new Set<string>()
  for (const p of plan) {
    needed.add(p.docId)
    if (p.baseId) needed.add(p.baseId)
  }
  const byDoc = await loadAttachments(db, accountId, Array.from(needed))
  return pickEffectiveAttachments(plan, byDoc)
}

interface TranslationDbRow {
  id: string
  language: KbLanguage
  status: KbStatus
  machine_translated: boolean
  translated_from_at: string | null
}

/** The translations of one base article. */
export async function loadTranslationsOf(
  db: SupabaseClient,
  accountId: string,
  baseId: string,
): Promise<TranslationRow[]> {
  const { data, error } = await db
    .from('ai_knowledge_documents')
    .select('id, language, status, machine_translated, translated_from_at')
    .eq('account_id', accountId)
    .eq('translation_of', baseId)
  if (error) {
    console.error('[knowledge translations] list failed:', error)
    return []
  }
  return (data ?? []) as TranslationDbRow[]
}

/** The base of a translation, with its last-change time. */
export async function loadBaseOf(
  db: SupabaseClient,
  accountId: string,
  baseId: string,
): Promise<(KnowledgeTranslationBase & { updated_at: string }) | null> {
  const { data } = await db
    .from('ai_knowledge_documents')
    .select('id, title, language, status, created_by, updated_at')
    .eq('account_id', accountId)
    .eq('id', baseId)
    .maybeSingle()
  return (data as (KnowledgeTranslationBase & { updated_at: string }) | null) ?? null
}

/**
 * The base was saved without a change to its text (published, AI switch,
 * collection ...). Its translations that were current a moment ago are still
 * current, so move their marker forward with the base's `updated_at`; ones
 * that were already out of date stay so. Best-effort: a failure only means a
 * translation shows "out of date" a little early.
 */
export async function keepTranslationsCurrent(
  db: SupabaseClient,
  accountId: string,
  baseId: string,
  previousUpdatedAt: string,
  newUpdatedAt: string,
): Promise<void> {
  if (!previousUpdatedAt || !newUpdatedAt || previousUpdatedAt === newUpdatedAt) return
  try {
    const { error } = await db
      .from('ai_knowledge_documents')
      .update({ translated_from_at: newUpdatedAt })
      .eq('account_id', accountId)
      .eq('translation_of', baseId)
      .gte('translated_from_at', previousUpdatedAt)
    if (error) console.warn('[knowledge translations] keep-current failed:', error)
  } catch (err) {
    console.warn('[knowledge translations] keep-current failed:', err)
  }
}
