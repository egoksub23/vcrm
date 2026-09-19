// ============================================================
// POST /api/tiktok/webhook
//
// TikTok pushes `comment.update` here (one URL per developer app,
// registered from Settings → Channels → TikTok). Delivery is at-least-once
// with retries for up to 72 hours, so: verify the signature over the RAW
// body, answer 200 straight away, and do the work afterwards. Duplicates
// are dropped by comment_webhook_events.
// ============================================================
import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { applyTikTokCommentEvent } from '@/lib/comments/tiktok/connection'
import { tiktokAppSecret } from '@/lib/comments/tiktok/api'
import { parseTikTokCommentEvent, verifyTikTokSignature } from '@/lib/comments/tiktok/webhook'

export const maxDuration = 60

export async function POST(request: Request) {
  const rawBody = await request.text()

  let secret: string
  try {
    secret = tiktokAppSecret()
  } catch {
    return NextResponse.json({ error: 'TikTok is not configured' }, { status: 503 })
  }

  if (!verifyTikTokSignature({ rawBody, header: request.headers.get('tiktok-signature'), secret })) {
    console.warn('[tiktok webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = parseTikTokCommentEvent(rawBody)
  if (event) {
    after(async () => {
      try {
        await applyTikTokCommentEvent(supabaseAdmin(), event)
      } catch (err) {
        console.error('[tiktok webhook] processing failed:', err)
      }
    })
  }
  // Anything else (other event types) is acknowledged and ignored.
  return NextResponse.json({ ok: true })
}
