import type { SupabaseClient } from '@supabase/supabase-js'

import { getValidAccessToken, type EmailConfigRow } from '@/lib/ms365/token'
import { createSubscription, deleteSubscription, renewSubscription } from '@/lib/ms365/mail-api'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Should the existing subscription be replaced rather than renewed? A subscription keeps the address
 * it was created with, and renewing never changes it, so when Halo's own address changes it would go on
 * calling the old one. The address is recorded at creation (migration 156): a different one, or none
 * recorded yet (NULL: created before it was tracked), means recreate. `undefined` means the column does
 * not exist yet (migration not applied), where the safe thing is to renew as before.
 */
export function subscriptionAddressChanged(recorded: string | null | undefined, current: string): boolean {
  if (recorded === undefined) return false
  return recorded === null || recorded.replace(/\/+$/, '') !== current.replace(/\/+$/, '')
}

/**
 * Renews (or, if it's already lapsed/missing or was made for another address, re-creates) one
 * mailbox's Graph change-notification subscription and persists the new id, expiry and address.
 * Shared by the cron sweep (subscription-renew) and the client-triggered heartbeat
 * (subscription-heartbeat) so both paths agree on exactly what "renew" means.
 */
export async function renewMailboxSubscription(args: {
  admin: SupabaseClient
  config: EmailConfigRow & {
    subscription_id: string | null
    client_state: string
    subscription_notification_url?: string | null
  }
  baseUrl: string
}): Promise<{ subscriptionId: string; expiresAt: string; recreated: boolean }> {
  const { admin, config, baseUrl } = args
  const accessToken = await getValidAccessToken(config)
  const notificationUrl = `${baseUrl}/api/email/webhook`
  const clientState = decrypt(config.client_state)

  const moved = !!config.subscription_id && subscriptionAddressChanged(config.subscription_notification_url, notificationUrl)
  let recreated = true
  let subscription
  if (!config.subscription_id || moved) {
    subscription = await createSubscription({ accessToken, notificationUrl, clientState })
    // The old one keeps delivering to the old address until it expires; drop it now (best effort).
    if (moved && config.subscription_id) {
      await deleteSubscription({ accessToken, subscriptionId: config.subscription_id }).catch(() => undefined)
    }
  } else {
    recreated = false
    subscription = await renewSubscription({ accessToken, subscriptionId: config.subscription_id }).catch(() => {
      recreated = true
      return createSubscription({ accessToken, notificationUrl, clientState })
    })
  }

  // A renewal keeps the address it was created with; only record a new one when a new subscription was made.
  const patch: Record<string, unknown> = {
    subscription_id: subscription.id,
    subscription_expires_at: subscription.expirationDateTime,
  }
  if (recreated) patch.subscription_notification_url = notificationUrl
  const { error } = await admin.from('email_config').update(patch).eq('id', config.id)
  // Before migration 156 the address column does not exist: save what matters, without it.
  if (error && recreated) {
    await admin
      .from('email_config')
      .update({ subscription_id: subscription.id, subscription_expires_at: subscription.expirationDateTime })
      .eq('id', config.id)
  }

  return { subscriptionId: subscription.id, expiresAt: subscription.expirationDateTime, recreated }
}
