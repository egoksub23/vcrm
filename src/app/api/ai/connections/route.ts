import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'
import { validateBaseUrl } from '@/lib/ai/base-url'
import { budgetState, tokensThisMonth } from '@/lib/ai/budget'
import { CONNECTION_NAME_MAX, fillRouting, probeConnection } from '@/lib/ai/connections'
import type { AiProvider } from '@/lib/ai/types'

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'openai_compatible']

/**
 * GET /api/ai/connections  (admin+)
 *
 * Everything the Connections screen needs in one read: the default
 * connection (the Setup tab's), the additional connections, the routing
 * for every AI job, and the monthly budget with this month's spend. Never
 * returns a key.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const [cfgRes, connRes, routeRes] = await Promise.all([
      supabase
        .from('ai_configs')
        .select('provider, model, base_url, is_active, monthly_token_budget, health_status, health_checked_at, health_error')
        .eq('account_id', accountId)
        .maybeSingle(),
      supabase
        .from('ai_connections')
        .select('id, name, provider, base_url, model, health_status, health_checked_at, health_error, created_at')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true }),
      supabase
        .from('ai_task_routing')
        .select('task, connection_id, model_override, enabled')
        .eq('account_id', accountId),
    ])
    if (cfgRes.error || connRes.error || routeRes.error) {
      console.error('[ai/connections GET] error:', cfgRes.error ?? connRes.error ?? routeRes.error)
      return NextResponse.json({ error: 'Failed to load AI connections' }, { status: 500 })
    }

    const cfg = cfgRes.data
    const used = (await tokensThisMonth(supabase, accountId)) ?? 0
    return NextResponse.json({
      default: cfg
        ? {
            configured: true,
            provider: cfg.provider,
            model: cfg.model,
            base_url: cfg.base_url,
            is_active: cfg.is_active,
            health_status: cfg.health_status,
            health_checked_at: cfg.health_checked_at,
            health_error: cfg.health_error,
          }
        : { configured: false },
      connections: connRes.data ?? [],
      routing: fillRouting(routeRes.data ?? []),
      budget: budgetState(used, cfg?.monthly_token_budget ?? null),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/connections  (admin+)
 * Body: { name, provider, base_url?, model, api_key, data_notice_ack? }
 *
 * Adds a connection. The key is verified against the provider first (the
 * same "verify before save" rule as the Setup tab); a connection that does
 * not work is not saved.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-conn:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const bad = (error: string, code = 'bad_request', status = 400) => NextResponse.json({ error, code }, { status })
    if (!body) return bad('Invalid request body')

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > CONNECTION_NAME_MAX) return bad(`Give the connection a name (up to ${CONNECTION_NAME_MAX} characters).`)
    const provider = body.provider as AiProvider
    if (!PROVIDERS.includes(provider)) return bad('Unknown provider')
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('Choose a model.', 'model_required')
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (!apiKey) return bad('Enter an API key.', 'key_required')

    let baseUrl: string | null = null
    let noticeAckAt: string | null = null
    if (provider === 'openai_compatible') {
      const checked = await validateBaseUrl(typeof body.base_url === 'string' ? body.base_url : null)
      if (!checked.ok) return bad('That base URL can’t be used.', checked.code)
      baseUrl = checked.url
      // Customer messages will be sent to this host: an admin must say
      // they know (same rule as the Setup tab).
      if (body.data_notice_ack !== true) return bad('Confirm that customer messages will be sent to this host.', 'notice_required')
      noticeAckAt = new Date().toISOString()
    }

    const probe = await probeConnection({ provider, baseUrl, model, apiKey })
    if (!probe.ok) return bad(probe.message, probe.code, probe.code === 'invalid_key' ? 400 : 502)

    const { data, error } = await supabase
      .from('ai_connections')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        provider,
        base_url: baseUrl,
        model,
        api_key: encrypt(apiKey),
        data_notice_ack_at: noticeAckAt,
        health_status: 'ok',
        health_checked_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error || !data) {
      console.error('[ai/connections POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to save the connection' }, { status: 500 })
    }
    return NextResponse.json({ success: true, id: data.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
