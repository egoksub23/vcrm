// ============================================================
// POST /api/account/channels/vircle-chat/test
//
// "Test connection": call the gateway's /v1/health with the stored API token
// and say what happened. Answers 200 with { ok: true } or { ok: false, error }
// whether or not the gateway is healthy: a failed test is a result, not a
// failure of this route.
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { vircleChatGate } from '@/lib/vircle-chat/admin-gate'
import { findConfigForAccount, openConfig } from '@/lib/vircle-chat/config'
import { checkGatewayHealth } from '@/lib/vircle-chat/gateway'

export async function POST() {
  try {
    const ctx = await requireCapability('channels.manage')
    const admin = supabaseAdmin()
    const refused = await vircleChatGate(admin, ctx, 'vircleChatTest')
    if (refused) return refused

    const row = await findConfigForAccount(admin, ctx.accountId)
    if (!row) return NextResponse.json({ error: 'Vircle Chat is not connected' }, { status: 404 })

    let apiToken: string
    try {
      apiToken = openConfig(row).apiToken
    } catch (error) {
      console.error('[POST vircle-chat/test] cannot decrypt the API token:', error)
      return NextResponse.json({ ok: false, error: 'The stored API token cannot be read. Rotate it and try again.' })
    }

    const result = await checkGatewayHealth({ baseUrl: row.gateway_base_url, apiToken })
    return NextResponse.json(result.ok ? { ok: true } : { ok: false, error: result.error })
  } catch (err) {
    return toErrorResponse(err)
  }
}
