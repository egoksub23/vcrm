// ============================================================
// POST /api/account/channels/vircle-chat/token
//
// Rotate the API token (the one Halo presents when it calls the gateway). The
// new plaintext is in THIS response and nowhere else; the old one stops
// working at once, so the gateway team must be given the new one.
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
    const refused = await vircleChatGate(admin, ctx, 'vircleChatToken')
    if (refused) return refused

    let apiToken: string | null
    try {
      apiToken = await rotateConnectionSecret(admin, ctx.accountId, 'api_token')
    } catch (error) {
      console.error('[POST vircle-chat/token] update error:', error)
      return NextResponse.json({ error: 'Failed to rotate the API token' }, { status: 500 })
    }
    if (!apiToken) return NextResponse.json({ error: 'Vircle Chat is not connected' }, { status: 404 })

    return NextResponse.json({ apiToken }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return toErrorResponse(err)
  }
}
