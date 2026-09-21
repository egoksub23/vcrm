// ============================================================
// POST /api/account/channels/web-widget/identity-token
//
// Admin-only. Mints a short-lived signed identity token for a pretend
// in-app user so the widget can be tested end to end from /widget-preview
// ("Simulate in-app user"). It signs with the workspace's real secret, so
// what it exercises is exactly what a host app's own backend would do.
//
// Body: { phone?: string, email?: string, name?: string }   (phone or email required)
// Response: { token, expires_in_seconds }
//
// Same gate as changing the widget's settings (`channels.manage`): being
// able to mint a token for ANY identity is being able to impersonate any
// customer to the widget, so it must not be open to every agent.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decryptIdentitySecret } from '@/lib/widget/identity-secret'
import {
  IDENTITY_TOKEN_MAX_AGE_SECONDS,
  normalizeEmail,
  normalizeIdentityPhone,
  signIdentityToken,
} from '@/lib/widget/identity-token'

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')

    const limit = checkRateLimit(`admin:webWidgetToken:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as
      | { phone?: unknown; email?: unknown; name?: unknown }
      | null

    const rawPhone = typeof body?.phone === 'string' ? body.phone.trim() : ''
    const rawEmail = typeof body?.email === 'string' ? body.email.trim() : ''
    if (!rawPhone && !rawEmail) {
      return NextResponse.json({ error: 'Enter a phone number or an email address' }, { status: 400 })
    }
    const phone = rawPhone ? normalizeIdentityPhone(rawPhone) : null
    if (rawPhone && !phone) return NextResponse.json({ error: 'Enter a valid phone number' }, { status: 400 })
    const email = rawEmail ? normalizeEmail(rawEmail) : null
    if (rawEmail && !email) return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 })
    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 120) : ''

    const { data: config, error } = await supabaseAdmin()
      .from('web_widget_config')
      .select('identity_secret_enc')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) {
      console.error('[POST web-widget/identity-token] lookup error:', error)
      return NextResponse.json({ error: 'Failed to load widget configuration' }, { status: 500 })
    }
    const secret = decryptIdentitySecret(config?.identity_secret_enc as string | null | undefined)
    if (!secret) {
      return NextResponse.json(
        { error: 'Generate the in-app identity secret first (Settings, Channels, Web Widget)' },
        { status: 409 },
      )
    }

    const token = signIdentityToken(secret, {
      ...(phone ? { phone } : {}),
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    })
    return NextResponse.json(
      { token, expires_in_seconds: IDENTITY_TOKEN_MAX_AGE_SECONDS },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
