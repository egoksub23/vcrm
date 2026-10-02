// ============================================================
// /api/whatsapp/app-secret — a workspace's OWN Meta App secret.
//
//   GET    — { has_app_secret }               any member
//   PUT    — { app_secret }                   channels.manage
//   DELETE —                                  channels.manage
//
// Needed only when this workspace's WhatsApp Business Account is
// subscribed to a Meta App that is NOT one of the operator's (the
// operator's secrets live in META_APP_SECRET). Meta signs every delivery
// with that app's secret; once it is registered here, a delivery signed
// with it is accepted for THIS workspace's number and WABA only, so a
// customer's own app can never sign messages into another workspace
// (migration 136, src/lib/whatsapp/webhook-signature.ts).
//
// The secret is stored encrypted (same key and format as every channel
// credential) and is never returned. The row must already exist: connect
// the number first.
// ============================================================
import { NextResponse } from 'next/server'

import {
  getCurrentAccount,
  requireCapability,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'

// Meta app secrets are 32 hex characters; allow a little slack for format changes.
const SECRET_RE = /^[A-Za-z0-9]{16,128}$/

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('app_secret_enc')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) {
      console.error('[GET /api/whatsapp/app-secret] read failed:', error)
      return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
    }
    return NextResponse.json(
      { has_app_secret: Boolean((data as { app_secret_enc?: string | null } | null)?.app_secret_enc) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')

    const limit = checkRateLimit(`admin:waAppSecret:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { app_secret?: unknown } | null
    const secret = typeof body?.app_secret === 'string' ? body.app_secret.trim() : ''
    if (!SECRET_RE.test(secret)) {
      return NextResponse.json(
        { error: 'That does not look like a Meta App Secret (letters and digits, 16 to 128 characters).' },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .update({ app_secret_enc: encrypt(secret) })
      .eq('account_id', ctx.accountId)
      .select('id')
    if (error) {
      console.error('[PUT /api/whatsapp/app-secret] update failed:', error)
      return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: 'Connect your WhatsApp number first, then add the app secret.' },
        { status: 404 },
      )
    }
    return NextResponse.json({ has_app_secret: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireCapability('channels.manage')

    const limit = checkRateLimit(`admin:waAppSecret:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { error } = await ctx.supabase
      .from('whatsapp_config')
      .update({ app_secret_enc: null })
      .eq('account_id', ctx.accountId)
    if (error) {
      console.error('[DELETE /api/whatsapp/app-secret] update failed:', error)
      return NextResponse.json({ error: 'Failed to remove' }, { status: 500 })
    }
    return NextResponse.json({ has_app_secret: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
