// ============================================================
// /api/account/channels/web-widget/identity-secret
//
//   POST   generate (first time) or rotate the workspace's in-app identity
//          secret. The plaintext is in THIS response and nowhere else, ever:
//          it is stored encrypted, and only its last four characters are kept
//          readable. Rotating immediately invalidates every token signed with
//          the old secret (a host app must be given the new one).
//   DELETE switch the in-app identity off: the secret is erased, so no
//          signed token can verify until a new one is generated.
//
// Admin capability `channels.manage` (the same gate as the widget settings).
// The widget settings must have been saved once (the config row must exist).
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { createIdentitySecret } from '@/lib/widget/identity-secret'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST() {
  try {
    const ctx = await requireCapability('channels.manage')

    const limit = checkRateLimit(`admin:webWidgetSecret:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: existing, error: lookupError } = await ctx.supabase
      .from('web_widget_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (lookupError) {
      console.error('[POST web-widget/identity-secret] lookup error:', lookupError)
      return NextResponse.json({ error: 'Failed to load widget configuration' }, { status: 500 })
    }
    if (!existing) {
      return NextResponse.json({ error: 'Save the widget settings first' }, { status: 409 })
    }

    const created = createIdentitySecret()
    const rotatedAt = new Date().toISOString()
    const { error } = await ctx.supabase
      .from('web_widget_config')
      .update({
        identity_secret_enc: created.enc,
        identity_secret_last4: created.last4,
        identity_secret_rotated_at: rotatedAt,
        updated_at: rotatedAt,
      })
      .eq('account_id', ctx.accountId)
    if (error) {
      console.error('[POST web-widget/identity-secret] update error:', error)
      return NextResponse.json({ error: 'Failed to save the secret' }, { status: 500 })
    }

    return NextResponse.json(
      { secret: created.secret, last4: created.last4, rotated_at: rotatedAt },
      { headers: NO_STORE },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireCapability('channels.manage')

    const limit = checkRateLimit(`admin:webWidgetSecret:${ctx.userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { error } = await ctx.supabase
      .from('web_widget_config')
      .update({
        identity_secret_enc: null,
        identity_secret_last4: null,
        identity_secret_rotated_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', ctx.accountId)
    if (error) {
      console.error('[DELETE web-widget/identity-secret] update error:', error)
      return NextResponse.json({ error: 'Failed to remove the secret' }, { status: 500 })
    }
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (err) {
    return toErrorResponse(err)
  }
}
