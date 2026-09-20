import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError, type AiConfig } from '@/lib/ai/types'
import type { KbLanguage } from '@/lib/ai/knowledge-query'
import type { KbKind, KbStatus } from '@/lib/ai/knowledge-doc'
import { plainTextToKbHtml } from '@/lib/knowledge-format'
import type { TranslateLanguageResult, TranslateResponse } from '@/lib/knowledge-types'
import { indexArticle } from './articles'
import {
  buildTranslatePrompt,
  buildTranslateUserMessage,
  canTranslateArticle,
  parseTargetLanguages,
  parseTranslation,
  translateMaxOutputTokens,
  TRANSLATE_MAX_INPUT_CHARS,
  TRANSLATE_TIMEOUT_MS,
} from './translate'

// ============================================================
// POST /api/knowledge/[id]/translate, as a function the route (and the
// tests) call. It never publishes and never indexes: a translation is written
// as a DRAFT with `machine_translated` set, `translation_of` pointing at the
// base and `translated_from_at` = the base's `updated_at` at that moment. An
// existing translation is replaced only when the caller said `overwrite`.
// ============================================================

export interface TranslateContext {
  /** The signed-in user's client: reads and writes run under RLS. */
  db: SupabaseClient
  /** Service role: the token budget check and the usage log. */
  admin: SupabaseClient
  accountId: string
  userId: string
  isAdmin: boolean
}

export interface TranslateHttpResult {
  status: number
  body: TranslateResponse
}

interface BaseRow {
  id: string
  title: string
  content: string
  content_html: string | null
  language: KbLanguage
  status: KbStatus
  created_by: string | null
  kind: KbKind
  use_in_ai: boolean
  review_by: string | null
  collection_id: string | null
  translation_of: string | null
  updated_at: string
}

interface ExistingRow {
  id: string
  language: KbLanguage
  status: KbStatus
  created_by: string | null
}

type InternalResult = TranslateLanguageResult & { httpStatus?: number }

const CODE_STATUS: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  invalid_language: 400,
  same_language: 400,
  translation_of_translation: 400,
  translation_exists: 409,
  ai_not_configured: 400,
  key_decrypt_failed: 400,
  budget_exceeded: 429,
  bad_model_output: 502,
  too_long: 422,
  save_failed: 500,
}

const fail = (language: KbLanguage, code: string, error: string, httpStatus?: number): InternalResult => ({
  language,
  ok: false,
  code,
  error,
  httpStatus: httpStatus ?? CODE_STATUS[code] ?? 500,
})

const requestError = (code: string, error: string): TranslateHttpResult => ({
  status: CODE_STATUS[code] ?? 400,
  body: { results: [], error, code },
})

const NOT_CONFIGURED =
  'AI is not set up, or the translate job is switched off. Set it up in AI Agents → Setup (and check AI Agents → Connections).'

/** The whole request: check the caller may translate this article, load the AI
 *  once, then translate each language in turn. One language failing never
 *  loses the others. */
export async function handleTranslate(
  ctx: TranslateContext,
  baseId: string,
  body: unknown,
): Promise<TranslateHttpResult> {
  const { db, accountId, userId, isAdmin } = ctx

  const { data: baseData, error: baseErr } = await db
    .from('ai_knowledge_documents')
    .select(
      'id, title, content, content_html, language, status, created_by, kind, use_in_ai, review_by, collection_id, translation_of, updated_at',
    )
    .eq('account_id', accountId)
    .eq('id', baseId)
    .maybeSingle()
  if (baseErr) {
    console.error('[knowledge translate] base load failed:', baseErr)
    return requestError('save_failed', 'Failed to load the article')
  }
  const base = baseData as BaseRow | null
  if (!base) return requestError('not_found', 'Not found')

  if (base.translation_of) {
    return requestError(
      'translation_of_translation',
      'This article is already a translation. Translate the original article instead.',
    )
  }
  if (!canTranslateArticle({ isAdmin, userId, article: base })) {
    return requestError('forbidden', 'You can only translate your own drafts. Ask an admin to translate published articles.')
  }

  const targets = parseTargetLanguages(body, base.language)
  if (!targets.ok) return requestError(targets.code, targets.error)
  const overwrite = !!body && typeof body === 'object' && (body as { overwrite?: unknown }).overwrite === true

  const { data: existingData } = await db
    .from('ai_knowledge_documents')
    .select('id, language, status, created_by')
    .eq('account_id', accountId)
    .eq('translation_of', base.id)
  const existing = new Map(((existingData ?? []) as ExistingRow[]).map((r) => [r.language, r]))

  const results: InternalResult[] = []
  const todo: KbLanguage[] = []
  for (const language of targets.languages) {
    const current = existing.get(language)
    if (!current) {
      todo.push(language)
    } else if (!overwrite) {
      results.push(
        fail(
          language,
          'translation_exists',
          'A translation in this language already exists. Re-translate it to replace it (this discards any edits).',
        ),
      )
    } else if (!isAdmin && (current.status !== 'draft' || current.created_by !== userId)) {
      results.push(fail(language, 'forbidden', 'You can only replace your own draft translations.'))
    } else {
      todo.push(language)
    }
  }

  if (todo.length > 0) {
    let config: AiConfig | null
    try {
      config = await loadAiConfig(db, accountId, { task: 'translate' })
    } catch (err) {
      console.error('[knowledge translate] loadAiConfig error:', err)
      return requestError('key_decrypt_failed', 'Stored API key could not be decrypted.')
    }
    if (!config) return requestError('ai_not_configured', NOT_CONFIGURED)

    const html = base.content_html?.trim() ? base.content_html : plainTextToKbHtml(base.content)
    if (html.length > TRANSLATE_MAX_INPUT_CHARS) {
      return requestError('too_long', 'This article is too long to translate in one go. Split it into shorter articles.')
    }

    let stopped: InternalResult | null = null
    for (const language of todo) {
      if (stopped) {
        results.push({ ...stopped, language })
        continue
      }
      const r = await translateOne(ctx, config, base, html, language, existing.get(language) ?? null)
      results.push(r)
      // The budget is used up for every remaining language too.
      if (!r.ok && r.code === 'budget_exceeded') stopped = r
    }
  }

  // Answer in the order asked.
  const order = new Map(targets.languages.map((l, i) => [l, i]))
  results.sort((a, b) => (order.get(a.language) ?? 0) - (order.get(b.language) ?? 0))
  const clean: TranslateLanguageResult[] = results.map(({ httpStatus, ...rest }) => {
    void httpStatus
    return rest
  })

  // Every language failed for the same reason: say so with that status.
  const first = results[0]
  if (first && !first.ok && results.every((r) => !r.ok && r.code === first.code)) {
    return { status: first.httpStatus ?? 500, body: { results: clean, error: first.error, code: first.code } }
  }
  return { status: 200, body: { results: clean } }
}

async function translateOne(
  ctx: TranslateContext,
  config: AiConfig,
  base: BaseRow,
  html: string,
  language: KbLanguage,
  existing: ExistingRow | null,
): Promise<InternalResult> {
  const { db, admin, accountId, userId } = ctx

  let text: string
  try {
    const out = await generateReply({
      config,
      systemPrompt: buildTranslatePrompt({ from: base.language, to: language }),
      messages: [
        { role: 'user', content: buildTranslateUserMessage({ from: base.language, to: language, title: base.title, html }) },
      ],
      guard: { db: admin, accountId },
      maxOutputTokens: translateMaxOutputTokens(html.length + base.title.length),
      timeoutMs: TRANSLATE_TIMEOUT_MS,
    })
    text = out.text
    // Tokens were spent whatever the answer looks like.
    void logAiUsage(admin, {
      accountId,
      conversationId: null,
      mode: 'translate',
      connectionId: config.connectionId,
      provider: config.provider,
      model: config.model,
      usage: out.usage,
    })
  } catch (err) {
    if (err instanceof AiError) return fail(language, err.code, err.message, err.status)
    console.error('[knowledge translate] model call failed:', err)
    return fail(language, 'ai_error', 'The AI request failed.', 502)
  }

  const parsed = parseTranslation(text)
  if (!parsed.ok) return fail(language, parsed.code, parsed.message)

  if (existing) {
    const { data, error } = await db
      .from('ai_knowledge_documents')
      .update({
        title: parsed.title,
        content: parsed.content,
        content_html: parsed.contentHtml,
        // Never live on the strength of a machine's text: a replaced
        // translation goes back to a draft for review.
        status: 'draft',
        machine_translated: true,
        translated_from_at: base.updated_at,
        updated_by: userId,
      })
      .eq('account_id', accountId)
      .eq('id', existing.id)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[knowledge translate] overwrite failed:', error)
      return fail(language, 'save_failed', 'Failed to save the translation')
    }
    if (!data) return fail(language, 'forbidden', 'You can only replace your own draft translations.')
    // It was live: take its passages out of search.
    if (existing.status === 'published') {
      const warning = await indexArticle(db, accountId, {
        id: existing.id,
        title: parsed.title,
        content: parsed.content,
        status: 'draft',
      })
      if (warning) console.warn('[knowledge translate] de-index warning:', warning)
    }
    return { language, ok: true, id: existing.id, overwritten: true }
  }

  const { data, error } = await db
    .from('ai_knowledge_documents')
    .insert({
      account_id: accountId,
      created_by: userId,
      updated_by: userId,
      title: parsed.title,
      content: parsed.content,
      content_html: parsed.contentHtml,
      language,
      status: 'draft',
      kind: base.kind,
      use_in_ai: base.use_in_ai,
      review_by: base.review_by,
      collection_id: base.collection_id,
      translation_of: base.id,
      machine_translated: true,
      translated_from_at: base.updated_at,
    })
    .select('id')
    .single()
  if (error || !data) {
    const code = (error as { code?: string } | null)?.code
    if (code === '23505') return fail(language, 'translation_exists', 'A translation in this language already exists.')
    if (code === '42501') return fail(language, 'forbidden', 'You cannot add a translation to this article.')
    console.error('[knowledge translate] insert failed:', error)
    return fail(language, 'save_failed', 'Failed to save the translation')
  }
  return { language, ok: true, id: (data as { id: string }).id, overwritten: false }
}
