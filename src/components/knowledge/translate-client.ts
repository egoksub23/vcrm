import type { KbLanguage } from '@/lib/ai/knowledge-query'
import type { TranslateLanguageResult, TranslateRequest, TranslateResponse } from '@/lib/knowledge-types'

// The browser side of POST /api/knowledge/[id]/translate: the call itself and
// the small pure helpers that turn its answer into per-language outcomes, so
// the editor and the library treat the answer the same way.

export type TranslateCall = TranslateResponse & { httpStatus: number }

export async function postTranslate(baseId: string, body: TranslateRequest): Promise<TranslateCall> {
  try {
    const res = await fetch(`/api/knowledge/${baseId}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as Partial<TranslateResponse>
    return {
      results: Array.isArray(data.results) ? data.results : [],
      error: typeof data.error === 'string' ? data.error : undefined,
      code: typeof data.code === 'string' ? data.code : undefined,
      httpStatus: res.status,
    }
  } catch {
    return { results: [], code: 'network', httpStatus: 0 }
  }
}

/** Error codes the interface has its own wording for (the server's text is
 *  shown for any other). */
export const TRANSLATE_ERROR_CODES = [
  'translation_exists',
  'budget_exceeded',
  'ai_not_configured',
  'key_decrypt_failed',
  'bad_model_output',
  'too_long',
  'forbidden',
  'not_found',
  'translation_of_translation',
  'same_language',
  'network',
] as const
export type TranslateErrorCode = (typeof TRANSLATE_ERROR_CODES)[number]

export function isKnownTranslateError(code: string | undefined): code is TranslateErrorCode {
  return !!code && (TRANSLATE_ERROR_CODES as readonly string[]).includes(code)
}

/** One outcome per language asked for. A request that failed as a whole (no
 *  permission, no AI set up, offline ...) has no per-language results, so
 *  the failure is repeated for each language. */
export function outcomesOf(call: TranslateCall, requested: KbLanguage[]): TranslateLanguageResult[] {
  if (call.results.length > 0) return call.results
  return requested.map((language) => ({
    language,
    ok: false,
    code: call.code ?? 'network',
    error: call.error,
  }))
}

/** The article a single-language translation produced, to open it. */
export function createdArticleId(outcomes: TranslateLanguageResult[]): string | null {
  return outcomes.find((o) => o.ok && o.id)?.id ?? null
}
