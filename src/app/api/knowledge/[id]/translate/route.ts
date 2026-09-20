import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { handleTranslate } from '@/lib/knowledge/translate-run'

// A long article can take a minute or two per language.
export const maxDuration = 300

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/knowledge/[id]/translate  (agent+; rate-limited)
 *
 * Body: `{ language }` or `{ languages: [...] }`, plus `overwrite: true` to
 * replace a translation that already exists. Translates the article's title
 * and text with the AI job `translate` and saves each result as a DRAFT
 * translation article (`machine_translated`, never published, never indexed).
 * An agent may translate their own draft article, an admin any article; a
 * translation itself cannot be translated.
 *
 * 200 `{ results: [{ language, ok, id?, overwritten?, code?, error? }] }`.
 * When every language failed for the same reason the status is that reason's
 * (409 translation_exists, 429 budget_exceeded, 400 ai_not_configured, 502
 * bad_model_output ...) and the body also carries `{ error, code }`.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId, role } = await requireRole('agent')
    const user = checkRateLimit(`kb-translate:${userId}`, RATE_LIMITS.aiDraft)
    if (!user.success) return rateLimitResponse(user)
    const account = checkRateLimit(`kb-translate-acct:${accountId}`, RATE_LIMITS.aiDraftAccount)
    if (!account.success) return rateLimitResponse(account)

    const { id } = await params
    const body = await request.json().catch(() => null)

    const result = await handleTranslate(
      { db: supabase, admin: supabaseAdmin(), accountId, userId, isAdmin: hasMinRole(role, 'admin') },
      id,
      body,
    )
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    return toErrorResponse(err)
  }
}
