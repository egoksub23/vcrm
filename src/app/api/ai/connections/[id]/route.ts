import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { CONNECTION_NAME_MAX, probeConnection } from '@/lib/ai/connections'
import type { AiProvider } from '@/lib/ai/types'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/ai/connections/[id]  (admin+)
 * Body: { name?, model?, api_key? }
 *
 * The provider and base URL are fixed once a connection exists: a stored
 * key may only ever be used against the host it was saved for, so
 * pointing it elsewhere means adding a new connection (and typing the key
 * again). A new key is verified before it replaces the old one.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-conn:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const { data: current } = await supabase
      .from('ai_connections')
      .select('id, provider, base_url, model, api_key')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const update: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name || name.length > CONNECTION_NAME_MAX) {
        return NextResponse.json({ error: `Give the connection a name (up to ${CONNECTION_NAME_MAX} characters).` }, { status: 400 })
      }
      update.name = name
    }
    const model = body.model !== undefined ? (typeof body.model === 'string' ? body.model.trim() : '') : (current.model as string)
    if (body.model !== undefined) {
      if (!model) return NextResponse.json({ error: 'Choose a model.', code: 'model_required' }, { status: 400 })
      update.model = model
    }

    const newKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (newKey || body.model !== undefined) {
      let apiKey = newKey
      if (!apiKey) {
        try {
          apiKey = decrypt(current.api_key as string)
        } catch {
          return NextResponse.json({ error: 'The stored key could not be decrypted. Enter it again.', code: 'key_decrypt_failed' }, { status: 400 })
        }
      }
      const probe = await probeConnection({
        provider: current.provider as AiProvider,
        baseUrl: (current.base_url as string | null) ?? null,
        model,
        apiKey,
      })
      if (!probe.ok) {
        return NextResponse.json({ error: probe.message, code: probe.code }, { status: probe.code === 'invalid_key' ? 400 : 502 })
      }
      if (newKey) update.api_key = encrypt(newKey)
      update.health_status = 'ok'
      update.health_checked_at = new Date().toISOString()
      update.health_error = null
    }
    if (Object.keys(update).length === 0) return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })

    const { error } = await supabase.from('ai_connections').update(update).eq('account_id', accountId).eq('id', id)
    if (error) {
      console.error('[ai/connections PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update the connection' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** DELETE /api/ai/connections/[id]  (admin+). Jobs routed to it fall back
 *  to the default connection (the routing row's connection is cleared). */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase.from('ai_connections').delete().eq('account_id', accountId).eq('id', id)
    if (error) {
      console.error('[ai/connections DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete the connection' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
