// POST /api/sembang/push/subscribe — store a browser PushSubscription
// DELETE /api/sembang/push/subscribe — remove a subscription (by endpoint)
//
// Body (POST): { endpoint: string, p256dh: string, auth: string }
// Body (DELETE): { endpoint: string }
//
// Multi-tenancy: account_id comes from ctx.accountId, enforced by RLS.
import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'

interface SubscribeBody {
  endpoint?: unknown;
  p256dh?: unknown;
  auth?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const body = (await request.json().catch(() => null)) as SubscribeBody | null

    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''
    const p256dh   = typeof body?.p256dh   === 'string' ? body.p256dh.trim()   : ''
    const authKey  = typeof body?.auth     === 'string' ? body.auth.trim()     : ''

    if (!endpoint || !p256dh || !authKey) {
      return NextResponse.json({ error: 'endpoint, p256dh, and auth are required' }, { status: 400 })
    }

    // Upsert — replace the row if the same user subscribes again from the same browser
    const { error } = await ctx.supabase
      .from('sembang_push_subscriptions')
      .upsert({
        account_id: ctx.accountId,
        user_id: ctx.userId,
        endpoint,
        p256dh,
        auth_key: authKey,
      }, { onConflict: 'user_id,endpoint' })

    if (error) {
      console.error('[POST /api/sembang/push/subscribe]', error.message)
      return NextResponse.json({ error: 'Failed to save subscription' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireCapability('menu.sembang')
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint.trim() : ''

    if (!endpoint) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 })
    }

    const { error } = await ctx.supabase
      .from('sembang_push_subscriptions')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('endpoint', endpoint)

    if (error) {
      console.error('[DELETE /api/sembang/push/subscribe]', error.message)
      return NextResponse.json({ error: 'Failed to remove subscription' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
