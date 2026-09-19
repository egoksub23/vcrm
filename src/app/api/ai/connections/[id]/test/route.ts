import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { probeConnection, recordConnectionHealth } from '@/lib/ai/connections'
import type { AiProvider } from '@/lib/ai/types'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/ai/connections/[id]/test  (admin+)
 *
 * Re-test a SAVED connection with its stored key and model and record the
 * result as its health. `id` is a connection id, or `default` for the
 * account's default connection (the Setup tab's).
 */
export async function POST(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-test:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    const isDefault = id === 'default'

    const { data: row } = isDefault
      ? await supabase.from('ai_configs').select('provider, base_url, model, api_key').eq('account_id', accountId).maybeSingle()
      : await supabase.from('ai_connections').select('provider, base_url, model, api_key').eq('account_id', accountId).eq('id', id).maybeSingle()
    if (!row?.api_key) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    let apiKey: string
    try {
      apiKey = decrypt(row.api_key as string)
    } catch {
      return NextResponse.json({ error: 'The stored key could not be decrypted. Enter it again.', code: 'key_decrypt_failed' }, { status: 400 })
    }

    const probe = await probeConnection({
      provider: row.provider as AiProvider,
      baseUrl: (row.base_url as string | null) ?? null,
      model: row.model as string,
      apiKey,
    })
    await recordConnectionHealth(supabase, { accountId, connectionId: isDefault ? null : id, probe })
    return NextResponse.json(
      probe.ok ? { ok: true, latency_ms: probe.latencyMs } : { ok: false, error: probe.message, code: probe.code },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
