// ============================================================
// /api/account/channels/web-widget
//
//   GET — the caller's web-widget config, or null if never set up.
//         Any member can read (mirrors /api/account/teams).
//   PUT — create or update the config. Admin+. Generates
//         `widget_token` once, on first save, and never changes it
//         on later saves (the embed snippet a customer already
//         pasted onto their site must keep working).
// ============================================================
import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import type { WebWidgetConfig } from '@/types'

const NAME_MAX_LEN = 80
const WELCOME_MAX_LEN = 300
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
const MAX_ORIGINS = 20

function generateWidgetToken(): string {
  return `wt_${randomBytes(24).toString('base64url')}`
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('web_widget_config')
      .select(
        'id, account_id, widget_token, name, welcome_message, primary_color, avatar_url, position, allowed_origins, enabled, created_at, updated_at',
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/account/channels/web-widget] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load widget configuration' }, { status: 500 })
    }

    return NextResponse.json({ config: (data as WebWidgetConfig | null) ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const limit = checkRateLimit(`admin:webWidgetConfig:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as
      | {
          name?: unknown
          welcome_message?: unknown
          primary_color?: unknown
          avatar_url?: unknown
          position?: unknown
          allowed_origins?: unknown
          enabled?: unknown
        }
      | null

    if (!body) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > NAME_MAX_LEN) {
      return NextResponse.json(
        { error: `Name is required and must be ${NAME_MAX_LEN} characters or fewer` },
        { status: 400 },
      )
    }

    const welcomeMessage = typeof body.welcome_message === 'string' ? body.welcome_message.trim() : ''
    if (welcomeMessage.length > WELCOME_MAX_LEN) {
      return NextResponse.json(
        { error: `Welcome message must be ${WELCOME_MAX_LEN} characters or fewer` },
        { status: 400 },
      )
    }

    let primaryColor = '#3b82f6'
    if (typeof body.primary_color === 'string' && HEX_COLOR_RE.test(body.primary_color)) {
      primaryColor = body.primary_color
    }

    const position = body.position === 'left' ? 'left' : 'right'

    let allowedOrigins: string[] = []
    if (Array.isArray(body.allowed_origins)) {
      allowedOrigins = body.allowed_origins
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter(Boolean)
        .slice(0, MAX_ORIGINS)
      for (const origin of allowedOrigins) {
        try {
          const url = new URL(origin)
          if (url.pathname !== '/' && url.pathname !== '') {
            return NextResponse.json(
              { error: `"${origin}" must be an origin (scheme + host), not a full URL` },
              { status: 400 },
            )
          }
        } catch {
          return NextResponse.json({ error: `"${origin}" is not a valid origin` }, { status: 400 })
        }
      }
    }

    const avatarUrl =
      typeof body.avatar_url === 'string' && body.avatar_url.trim() ? body.avatar_url.trim() : null

    const enabled = body.enabled !== false

    const { data: existing } = await ctx.supabase
      .from('web_widget_config')
      .select('id, widget_token')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const row = {
      name,
      welcome_message: welcomeMessage || 'Hi there! How can we help?',
      primary_color: primaryColor,
      avatar_url: avatarUrl,
      position,
      allowed_origins: allowedOrigins,
      enabled,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { data, error } = await ctx.supabase
        .from('web_widget_config')
        .update(row)
        .eq('account_id', ctx.accountId)
        .select(
          'id, account_id, widget_token, name, welcome_message, primary_color, avatar_url, position, allowed_origins, enabled, created_at, updated_at',
        )
        .single()

      if (error) {
        console.error('[PUT /api/account/channels/web-widget] update error:', error)
        return NextResponse.json({ error: 'Failed to update widget configuration' }, { status: 500 })
      }
      return NextResponse.json({ config: data })
    }

    const { data, error } = await ctx.supabase
      .from('web_widget_config')
      .insert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        widget_token: generateWidgetToken(),
        ...row,
      })
      .select(
        'id, account_id, widget_token, name, welcome_message, primary_color, avatar_url, position, allowed_origins, enabled, created_at, updated_at',
      )
      .single()

    if (error) {
      console.error('[PUT /api/account/channels/web-widget] insert error:', error)
      return NextResponse.json({ error: 'Failed to save widget configuration' }, { status: 500 })
    }

    return NextResponse.json({ config: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
