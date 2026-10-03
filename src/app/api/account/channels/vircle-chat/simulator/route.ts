// ============================================================
// POST /api/account/channels/vircle-chat/simulator
//
// "Open simulator": answers with the address of the gateway's simulator page, carrying a short-lived
// launch token (lib/vircle-chat/simulator.ts) that tells the gateway this is a signed-in admin of this
// workspace. Needs `channels.manage`, like every Vircle Chat setting.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { vircleChatGate } from '@/lib/vircle-chat/admin-gate'
import { findConfigForAccount, openConfig } from '@/lib/vircle-chat/config'
import { simulatorUrl } from '@/lib/vircle-chat/simulator'

export async function POST() {
  try {
    const ctx = await requireCapability('channels.manage')
    const admin = supabaseAdmin()
    const refused = await vircleChatGate(admin, ctx, 'vircleChatSimulator')
    if (refused) return refused

    const row = await findConfigForAccount(admin, ctx.accountId)
    if (!row) return NextResponse.json({ error: 'Vircle Chat is not connected' }, { status: 404 })

    let signingSecret: string
    try {
      signingSecret = openConfig(row).signingSecret
    } catch (error) {
      console.error('[POST vircle-chat/simulator] cannot decrypt the signing secret:', error)
      return NextResponse.json({ error: 'The stored signing secret cannot be read. Rotate it and try again.' }, { status: 500 })
    }

    return NextResponse.json(
      { url: simulatorUrl(row.gateway_base_url, signingSecret, row.workspace_key) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
