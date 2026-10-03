// ============================================================
// /api/account/channels/vircle-chat
//
// A workspace's connection to the Vircle chat gateway
// (docs/vircle-chat-setup.md, docs/vircle-chat-contract.md).
//
//   GET    the connection as the settings screen may see it, plus the webhook
//          address the gateway posts to. NEVER a secret, not even encrypted.
//   PUT    save the gateway address. The first save also creates the
//          connection: a workspace key, a signing secret and an API token are
//          generated, stored encrypted, and the two secrets come back in
//          THIS response once (Cache-Control: no-store) and never again.
//   PATCH  the pause switch (`enabled`).
//   DELETE remove the connection.
//
// All of it needs `channels.manage`, and the operator's Vircle Chat flag for
// the workspace (the GET says so with `featureEnabled: false`, the writes
// answer 403).
// ============================================================
import { NextResponse } from 'next/server'

import { requireCapability, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getOAuthBaseUrl } from '@/lib/gmail/oauth'
import { vircleChatGate } from '@/lib/vircle-chat/admin-gate'
import {
  findConfigForAccount,
  generateApiToken,
  generateSigningSecret,
  generateWorkspaceKey,
  sealSecret,
  toConfigView,
  type VircleChatConfigRow,
} from '@/lib/vircle-chat/config'
import { vircleChatEnabled } from '@/lib/vircle-chat/feature'
import { normalizeGatewayUrl } from '@/lib/vircle-chat/gateway'

const NO_STORE = { 'Cache-Control': 'no-store' }
const BUCKET = 'vircleChat'

const webhookUrlFor = (request: Request) => `${getOAuthBaseUrl(request)}/api/vircle-chat/webhook`

export async function GET(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')
    const admin = supabaseAdmin()
    const webhookUrl = webhookUrlFor(request)

    if (!(await vircleChatEnabled(admin, ctx.accountId))) {
      return NextResponse.json(
        { featureEnabled: false, configured: false, config: null, webhookUrl },
        { headers: NO_STORE },
      )
    }

    const row = await findConfigForAccount(admin, ctx.accountId)
    return NextResponse.json(
      { featureEnabled: true, configured: !!row, config: row ? toConfigView(row) : null, webhookUrl },
      { headers: NO_STORE },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')
    const admin = supabaseAdmin()
    const refused = await vircleChatGate(admin, ctx, BUCKET)
    if (refused) return refused

    const body = (await request.json().catch(() => null)) as
      | { gateway_base_url?: unknown }
      | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    if (typeof body.gateway_base_url !== 'string') {
      return NextResponse.json({ error: 'Enter the gateway address' }, { status: 400 })
    }
    const url = normalizeGatewayUrl(body.gateway_base_url)
    if (!url.ok) return NextResponse.json({ error: url.error }, { status: 400 })

    const webhookUrl = webhookUrlFor(request)
    const existing = await findConfigForAccount(admin, ctx.accountId)
    const now = new Date().toISOString()

    if (existing) {
      const { data, error } = await admin
        .from('vircle_chat_config')
        .update({
          gateway_base_url: url.url,
          updated_at: now,
        })
        .eq('account_id', ctx.accountId)
        .select('*')
        .single()
      if (error || !data) {
        console.error('[PUT /api/account/channels/vircle-chat] update error:', error)
        return NextResponse.json({ error: 'Failed to save the Vircle Chat connection' }, { status: 500 })
      }
      return NextResponse.json(
        { configured: true, config: toConfigView(data as VircleChatConfigRow), webhookUrl },
        { headers: NO_STORE },
      )
    }

    // First save: generate the three values the gateway team needs. The two
    // secrets are returned in plaintext below, and stored only as ciphertext.
    const signingSecret = generateSigningSecret()
    const apiToken = generateApiToken()
    const { data, error } = await admin
      .from('vircle_chat_config')
      .insert({
        account_id: ctx.accountId,
        workspace_key: generateWorkspaceKey(),
        gateway_base_url: url.url,
        signing_secret: sealSecret(signingSecret),
        api_token: sealSecret(apiToken),
        connected_by_user_id: ctx.userId,
      })
      .select('*')
      .single()
    if (error || !data) {
      if (error?.code === '23505') {
        return NextResponse.json({ error: 'Vircle Chat is already connected. Reload the page.' }, { status: 409 })
      }
      console.error('[PUT /api/account/channels/vircle-chat] insert error:', error)
      return NextResponse.json({ error: 'Failed to save the Vircle Chat connection' }, { status: 500 })
    }

    return NextResponse.json(
      {
        configured: true,
        config: toConfigView(data as VircleChatConfigRow),
        webhookUrl,
        secrets: { signingSecret, apiToken },
      },
      { status: 201, headers: NO_STORE },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireCapability('channels.manage')
    const admin = supabaseAdmin()
    const refused = await vircleChatGate(admin, ctx, BUCKET)
    if (refused) return refused

    const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 })
    }
    const patch = { enabled: body.enabled }

    const { data, error } = await admin
      .from('vircle_chat_config')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[PATCH /api/account/channels/vircle-chat] update error:', error)
      return NextResponse.json({ error: 'Failed to update Vircle Chat' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Vircle Chat is not connected' }, { status: 404 })

    return NextResponse.json({ success: true, ...patch })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireCapability('channels.manage')
    const admin = supabaseAdmin()
    const refused = await vircleChatGate(admin, ctx, BUCKET)
    if (refused) return refused

    const { error } = await admin.from('vircle_chat_config').delete().eq('account_id', ctx.accountId)
    if (error) {
      console.error('[DELETE /api/account/channels/vircle-chat] delete error:', error)
      return NextResponse.json({ error: 'Failed to disconnect Vircle Chat' }, { status: 500 })
    }
    return NextResponse.json({ disconnected: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
