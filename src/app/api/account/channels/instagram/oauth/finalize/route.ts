// ============================================================
// POST /api/account/channels/instagram/oauth/finalize
// Body: { connection_id, page_id }
//
// Same re-derive-fresh-token shape as Messenger's finalize route, plus
// the IG Business Account resolution step — the chosen Page must have
// one linked, or connecting fails with a clear error.
// ============================================================
import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { getInstagramBusinessAccount, getPageAccessToken } from '@/lib/meta/oauth'
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
      pending.channel !== 'instagram' ||
      !pending.long_lived_user_token
    ) {
      return NextResponse.json({ error: 'Connection not found or expired' }, { status: 404 })
    }

    const userAccessToken = decrypt(pending.long_lived_user_token)
    const page = await getPageAccessToken({ userAccessToken, pageId })
    if (!page) {
      return NextResponse.json({ error: 'Selected Page is no longer available' }, { status: 400 })
    }

    const igAccount = await getInstagramBusinessAccount({
      pageId: page.id,
      pageAccessToken: page.accessToken,
    })
    if (!igAccount) {
      return NextResponse.json(
        { error: 'Selected Page has no linked Instagram professional account' },
        { status: 400 },
      )
    }

    const { data: existing } = await db
      .from('instagram_config')
      .select('id')
      .eq('account_id', pending.account_id)
      .maybeSingle()

    const row = {
      account_id: pending.account_id,
      connected_by_user_id: pending.initiated_by_user_id,
      page_id: page.id,
      ig_business_account_id: igAccount.id,
      ig_username: igAccount.username ?? null,
      page_access_token: encrypt(page.accessToken),
      long_lived_user_token: encrypt(userAccessToken),
      needs_reauth: false,
      status: 'connected' as const,
      connected_at: new Date().toISOString(),
    }

    if (existing) {
      await db.from('instagram_config').update(row).eq('id', existing.id)
    } else {
      await db.from('instagram_config').insert(row)
    }
    await markCompleted(db, pending.id)

    return NextResponse.json({ connected: true, ig_username: igAccount.username ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
