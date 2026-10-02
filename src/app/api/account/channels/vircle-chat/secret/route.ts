// ============================================================
// POST /api/account/channels/vircle-chat/secret
//
// Rotate the signing secret (the one the gateway signs its events with). The
// new plaintext is in THIS response and nowhere else; the old one stops
// verifying at once, so the gateway team must be given the new one.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { vircleChatGate } from '@/lib/vircle-chat/admin-gate'
import { rotateConnectionSecret } from '@/lib/vircle-chat/rotate'

export async function POST() {
  try {
    const ctx = await requireCapability('channels.manage')
    const admin = supabaseAdmin()
    const refused = await vircleChatGate(admin, ctx, 'vircleChatSecret')
    if (refused) return refused

    let signingSecret: string | null
    try {
      signingSecret = await rotateConnectionSecret(admin, ctx.accountId, 'signing_secret')
    } catch (error) {
      console.error('[POST vircle-chat/secret] update error:', error)
      return NextResponse.json({ error: 'Failed to rotate the signing secret' }, { status: 500 })
    }
    if (!signingSecret) return NextResponse.json({ error: 'Vircle Chat is not connected' }, { status: 404 })

    return NextResponse.json({ signingSecret }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
