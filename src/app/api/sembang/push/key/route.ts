// GET /api/sembang/push/key
// Returns the VAPID public key for the browser to create a PushSubscription.
// The key is set via the NEXT_PUBLIC_VAPID_PUBLIC_KEY env var (or VAPID_PUBLIC_KEY).
// Generate a keypair with: npx web-push generate-vapid-keys
import { NextResponse } from 'next/server'
import { requireCapability, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    await requireCapability('menu.sembang')

    const key =
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ??
      process.env.VAPID_PUBLIC_KEY

    if (!key) {
      return NextResponse.json({ error: 'Push not configured — set VAPID_PUBLIC_KEY' }, { status: 503 })
    }

    return NextResponse.json({ publicKey: key })
  } catch (err) {
    return toErrorResponse(err)
  }
}
