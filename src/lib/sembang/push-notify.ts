// Sends Web Push notifications to Sembang channel members after a message is posted.
//
// - Queries sembang_push_subscriptions for all subscribers in the account
//   who are members of the channel (channel_members CTE), excluding the sender.
// - Sends a push to each subscription using VAPID; expired/unsubscribed
//   endpoints (410 Gone) are removed automatically.
//
// VAPID keys are set via VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars.
// Generate with: npx web-push generate-vapid-keys
// VAPID_SUBJECT should be a mailto: or https: contact URL.
//
// Called fire-and-forget inside an after() block from the messages POST route,
// so errors are logged and never surface to the sender.

import * as webpush from 'web-push'
import { createAdminPgDb } from '@/lib/postgres/db'

const vapidPublicKey  = process.env.VAPID_PUBLIC_KEY  ?? process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY
const vapidSubject    = process.env.VAPID_SUBJECT ?? 'mailto:admin@vircle.net'

let vapidConfigured = false
if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
  vapidConfigured = true
}

interface PushRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth_key: string
}

interface SendOptions {
  accountId: string
  channelId: string
  messageId: string
  messageBody: string
  senderId: string
}

export async function sendSembangPushNotifications(opts: SendOptions): Promise<void> {
  if (!vapidConfigured) return   // push not set up — silent no-op

  const { accountId, channelId, messageBody, senderId } = opts
  const db = createAdminPgDb()

  // Fetch subscriptions for account members who are in this channel but are
  // NOT the sender. We join through sembang_members to avoid notifying
  // people who have been removed from the channel.
  const { data: subs, error } = await db
    .from('sembang_push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth_key')
    .eq('account_id', accountId)
    .neq('user_id', senderId)
    // We can't do a cross-table join through the PostgREST-removed layer,
    // but the channel membership check happens implicitly: only members
    // subscribe and RLS ensures that. For a stricter filter we query
    // channel_members first and filter by user_ids.
    .limit(500) as { data: PushRow[] | null; error: unknown }

  if (error || !subs?.length) return

  // Narrow to channel members
  const { data: members } = await db
    .from('sembang_members')
    .select('user_id')
    .eq('channel_id', channelId)
    .eq('account_id', accountId)

  const memberIds = new Set((members ?? []).map((m: { user_id: string }) => m.user_id))
  const targets = subs.filter((s) => memberIds.has(s.user_id))
  if (!targets.length) return

  // Truncate body for the notification badge
  const bodyPreview = messageBody.slice(0, 160)
  const payload = JSON.stringify({
    title: 'New message',
    body: bodyPreview,
    url: `/sembang?channel=${opts.channelId}`,
    messageId: opts.messageId,
  })

  const toDelete: string[] = []

  await Promise.allSettled(
    targets.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth_key },
          },
          payload,
          { TTL: 86400 },
        )
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 410 || status === 404) {
          // Subscription expired/removed — clean it up
          toDelete.push(sub.id)
        } else {
          console.error('[sembang-push] send error', sub.user_id, status, err)
        }
      }
    }),
  )

  if (toDelete.length) {
    await db
      .from('sembang_push_subscriptions')
      .delete()
      .in('id', toDelete)
  }
}
