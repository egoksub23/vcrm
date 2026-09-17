// ============================================================
// POST /api/account/channels/messenger/oauth/finalize
// Body: { connection_id, page_id }
//
// Re-derives the chosen Page's access token fresh (rather than
// trusting anything cached from the /oauth/pages list call) before
// encrypting and upserting messenger_config. Keeps live Page tokens
// out of `oauth_pending_connections.pages_json` entirely — only the
// token for the Page actually picked is ever persisted.
// ============================================================
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { getPageAccessToken } from '@/lib/meta/oauth'
import { findPendingConnectionById, markCompleted } from '@/lib/meta/oauth-connect'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as
      | { connection_id?: unknown; page_id?: unknown }
      | null
    const connectionId = typeof body?.connection_id === 'string' ? body.connection_id : null
    const pageId = typeof body?.page_id === 'string' ? body.page_id : null
    if (!connectionId || !pageId) {
      return NextResponse.json({ error: 'connection_id and page_id are required' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const pending = await findPendingConnectionById(db, connectionId)
    if (
      !pending ||
      pending.account_id !== ctx.accountId ||
      pending.channel !== 'messenger' ||
      !pending.long_lived_user_token
    ) {
      return NextResponse.json({ error: 'Connection not found or expired' }, { status: 404 })
    }

    const userAccessToken = decrypt(pending.long_lived_user_token)
    const page = await getPageAccessToken({ userAccessToken, pageId })
    if (!page) {
      return NextResponse.json({ error: 'Selected Page is no longer available' }, { status: 400 })
    }

    const { data: existing } = await db
      .from('messenger_config')
      .select('id')
      .eq('account_id', pending.account_id)
      .maybeSingle()

    const row = {
      account_id: pending.account_id,
      connected_by_user_id: pending.initiated_by_user_id,
      page_id: page.id,
      page_name: page.name,
      page_access_token: encrypt(page.accessToken),
      long_lived_user_token: encrypt(userAccessToken),
      needs_reauth: false,
      status: 'connected' as const,
      connected_at: new Date().toISOString(),
    }

    if (existing) {
      await db.from('messenger_config').update(row).eq('id', existing.id)
    } else {
      await db.from('messenger_config').insert(row)
    }
    await markCompleted(db, pending.id)

    return NextResponse.json({ connected: true, page_name: page.name })
  } catch (err) {
    return toErrorResponse(err)
  }
}
