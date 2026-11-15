// POST /api/sembang/webhook/[token]
//
// Slack-compatible inbound webhook endpoint. Accepts the same payload shape
// as a Slack incoming webhook:
//
//   { "text": "Hello from CI!", "username": "GitHub Actions" }
//
// Also accepts a richer subset:
//   {
//     "text": "Deploy succeeded",
//     "username": "GitHub Actions",
//     "icon_emoji": ":rocket:",
//     "attachments": [{ "color": "#36a64f", "title": "...", "text": "..." }]
//   }
//
// The attachments are stored in the `cards` JSONB column (migration 234).
//
// No auth required — the token IS the credential. The endpoint is public
// but rate-limited implicitly by the fact that a valid token must exist
// in `sembang_webhooks`. Runs as the service role (admin DB client) so the
// bot can post to channels without being a member.
import { NextResponse } from 'next/server'
import { createAdminPgDb } from '@/lib/postgres/db'

interface SlackAttachment {
  color?: string
  pretext?: string
  title?: string
  title_link?: string
  text?: string
  fields?: Array<{ title?: string; value?: string; short?: boolean }>
  footer?: string
  ts?: string | number
}

interface WebhookPayload {
  text?: unknown
  username?: unknown
  icon_emoji?: unknown
  icon_url?: unknown
  attachments?: unknown
  // Halo extension: structured card array (same as the bot cards schema)
  cards?: unknown
}

const BODY_MAX = 8000
const AUTHOR_MAX = 100

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  if (!token || token.length < 10) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
  }

  const db = createAdminPgDb()

  // Validate the token
  const { data: webhook, error: whErr } = await db
    .from('sembang_webhooks')
    .select('id, account_id, channel_id, name, is_active')
    .eq('token', token)
    .single()

  if (whErr || !webhook) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
  }

  if (!webhook.is_active) {
    return NextResponse.json({ error: 'webhook_disabled' }, { status: 403 })
  }

  let payload: WebhookPayload
  const contentType = request.headers.get('content-type') ?? ''

  try {
    if (contentType.includes('application/json')) {
      payload = (await request.json()) as WebhookPayload
    } else {
      // Slack also supports application/x-www-form-urlencoded with payload=<json>
      const formText = await request.text()
      const form = new URLSearchParams(formText)
      const payloadStr = form.get('payload')
      payload = payloadStr ? (JSON.parse(payloadStr) as WebhookPayload) : {}
    }
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
  const author = typeof payload?.username === 'string'
    ? payload.username.slice(0, AUTHOR_MAX)
    : webhook.name

  if (!text && !payload?.attachments && !payload?.cards) {
    return NextResponse.json({ error: 'text or attachments required' }, { status: 400 })
  }

  // Map Slack attachments → Halo card schema
  let cards: unknown[] | null = null
  if (Array.isArray(payload?.cards)) {
    cards = payload.cards as unknown[]
  } else if (Array.isArray(payload?.attachments)) {
    cards = (payload.attachments as SlackAttachment[]).map((a) => ({
      color: a.color ?? null,
      title: a.title ?? null,
      title_url: a.title_link ?? null,
      pretext: a.pretext ?? null,
      text: a.text ?? null,
      fields: Array.isArray(a.fields)
        ? a.fields.map((f) => ({ title: f.title ?? '', value: f.value ?? '', short: f.short ?? false }))
        : null,
      footer: a.footer ?? null,
    }))
  }

  const bodyText = text.slice(0, BODY_MAX) || (cards ? '' : '(no text)')

  const { error: insertErr } = await db
    .from('sembang_messages')
    .insert({
      account_id: webhook.account_id,
      channel_id: webhook.channel_id,
      author_id: null,          // bot message — no user author
      body: bodyText,
      mentions: [],
      bot_name: author,
      cards: cards ?? undefined,
    })

  if (insertErr) {
    // bot_name column may not exist in older schemas — log and 500
    console.error('[POST /api/sembang/webhook/[token]] insert error:', insertErr.message)
    return NextResponse.json({ error: 'Failed to post message' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
